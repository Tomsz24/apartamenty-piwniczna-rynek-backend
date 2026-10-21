import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { ApnsClient, ApnsEnvironment } from './apns.client';
import {
  buildApnsPayload,
  classifyApnsResponse,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_PUSH_MAX_AGE_MS,
  notificationPreferenceFor,
  notificationRetryDelaySeconds,
} from './notification.domain';

type EventRow = {
  id: string;
  event_type: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  attempt_count: number;
  created_at: Date | string;
};

type RecipientRow = {
  device_id: string;
  device_token: string;
  environment: ApnsEnvironment;
  admin_user_id: string | null;
  admin_email: string;
  allowed: boolean;
  delivery_status: string | null;
};

const EVENTS_PER_RUN = 10;

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);
  private readonly enabled: boolean;
  private busy = false;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly apns: ApnsClient,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<string>('NOTIFICATIONS_ENABLED')?.trim().toLowerCase() === 'true';
  }

  isActive(): boolean {
    return this.enabled && this.apns.isConfigured();
  }

  getStatus() {
    return { enabled: this.enabled, apns: this.apns.getStatus() };
  }

  @Cron('*/15 * * * * *')
  async dispatch(): Promise<void> {
    if (!this.isActive() || this.busy) return;
    this.busy = true;
    try {
      await this.releaseStuckEvents();
      for (const event of await this.claimEvents()) {
        await this.dispatchEvent(event);
      }
    } catch (error) {
      this.logger.error(`Wysyłka powiadomień nie powiodła się: ${this.safeMessage(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async releaseStuckEvents(): Promise<void> {
    await this.pool.query(
      `UPDATE notification_events SET status = 'pending', updated_at = NOW()
       WHERE status = 'processing' AND updated_at < NOW() - interval '10 minutes'`,
    );
  }

  private async claimEvents(): Promise<EventRow[]> {
    // SKIP LOCKED keeps two backend instances from pushing the same event twice.
    const result = await this.pool.query<EventRow>(
      `UPDATE notification_events SET
         status = 'processing', attempt_count = attempt_count + 1, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM notification_events
         WHERE status = 'pending' AND scheduled_for <= NOW()
         ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                  scheduled_for
         FOR UPDATE SKIP LOCKED
         LIMIT ${EVENTS_PER_RUN}
       )
       RETURNING id, event_type, title, body, payload, attempt_count, created_at`,
    );
    return result.rows;
  }

  private async dispatchEvent(event: EventRow): Promise<void> {
    const createdAt = new Date(event.created_at).getTime();
    if (Date.now() - createdAt > NOTIFICATION_PUSH_MAX_AGE_MS) {
      // Stays visible in the in-app inbox; a stale push would only confuse.
      await this.finishEvent(event.id, 'failed', 'Powiadomienie wygasło przed wysyłką push');
      return;
    }

    const recipients = await this.recipients(event);
    let retryable = 0;
    let lastError: string | null = null;
    const badges = new Map<string, number>();

    for (const recipient of recipients) {
      if (recipient.delivery_status === 'sent' || recipient.delivery_status === 'skipped') continue;
      const deliveryId = await this.upsertDelivery(event.id, recipient);
      if (!recipient.allowed) {
        await this.updateDelivery(deliveryId, 'skipped', null, null);
        continue;
      }

      const badgeKey = recipient.admin_user_id ?? recipient.admin_email;
      if (!badges.has(badgeKey)) badges.set(badgeKey, await this.unreadCount(recipient));
      const payload = buildApnsPayload({
        id: event.id,
        eventType: event.event_type,
        title: event.title,
        body: event.body,
        payload: event.payload ?? {},
        badge: badges.get(badgeKey) ?? 0,
      });

      try {
        const result = await this.apns.send(recipient.environment, recipient.device_token, payload, {
          collapseId: event.id,
          expiresAt: new Date(createdAt + NOTIFICATION_PUSH_MAX_AGE_MS),
        });
        const outcome = classifyApnsResponse(result.status, result.reason);
        const error = outcome === 'sent' ? null : `APNs ${result.status}${result.reason ? ` ${result.reason}` : ''}`;
        if (outcome === 'sent') {
          await this.updateDelivery(deliveryId, 'sent', result.apnsId, null);
          await this.markDeviceHealthy(recipient.device_id);
        } else if (outcome === 'invalid_token') {
          await this.updateDelivery(deliveryId, 'skipped', null, error);
          await this.disableDevice(recipient.device_id, error!);
        } else if (outcome === 'retry') {
          retryable += 1;
          lastError = error;
          await this.updateDelivery(deliveryId, 'failed', null, error);
        } else {
          lastError = error;
          await this.updateDelivery(deliveryId, 'failed', null, error);
          await this.recordDeviceFailure(recipient.device_id, error!);
        }
      } catch (sendError) {
        retryable += 1;
        lastError = this.safeMessage(sendError);
        await this.updateDelivery(deliveryId, 'failed', null, lastError);
      }
    }

    if (retryable > 0 && event.attempt_count < NOTIFICATION_MAX_ATTEMPTS) {
      await this.pool.query(
        `UPDATE notification_events SET
           status = 'pending', last_error = $2, updated_at = NOW(),
           scheduled_for = NOW() + make_interval(secs => $3)
         WHERE id = $1`,
        [event.id, lastError, notificationRetryDelaySeconds(event.attempt_count)],
      );
      return;
    }
    await this.finishEvent(event.id, retryable > 0 ? 'failed' : 'sent', lastError);
  }

  private async recipients(event: EventRow): Promise<RecipientRow[]> {
    const preference = notificationPreferenceFor(event.event_type);
    const result = await this.pool.query<RecipientRow>(
      `SELECT device.id AS device_id, device.device_token, device.environment,
              device.admin_user_id, device.admin_email,
              ${preference ? `COALESCE(preference.${preference}, true)` : 'true'} AS allowed,
              delivery.status AS delivery_status
       FROM notification_devices AS device
       LEFT JOIN LATERAL (
         SELECT * FROM notification_preferences AS candidate
         WHERE candidate.admin_user_id = device.admin_user_id
            OR lower(candidate.admin_email) = lower(device.admin_email)
         ORDER BY (candidate.admin_user_id = device.admin_user_id) DESC
         LIMIT 1
       ) AS preference ON true
       LEFT JOIN notification_deliveries AS delivery
         ON delivery.notification_event_id = $1 AND delivery.device_id = device.id
       WHERE device.enabled = true
         AND device.push_provider = 'apns'
         AND device.platform = 'ios'`,
      [event.id],
    );
    return result.rows;
  }

  private async unreadCount(recipient: RecipientRow): Promise<number> {
    if (!recipient.admin_user_id) return 0;
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM notification_events AS event
       WHERE event.status <> 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM notification_event_reads AS reads
           WHERE reads.notification_event_id = event.id AND reads.admin_user_id = $1
         )`,
      [recipient.admin_user_id],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async upsertDelivery(eventId: string, recipient: RecipientRow): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO notification_deliveries (
         notification_event_id, device_id, push_provider, device_token_snapshot, status, attempt_count
       ) VALUES ($1, $2, 'apns', $3, 'processing', 1)
       ON CONFLICT (notification_event_id, device_id) DO UPDATE SET
         status = 'processing', attempt_count = notification_deliveries.attempt_count + 1,
         updated_at = NOW()
       RETURNING id`,
      [eventId, recipient.device_id, recipient.device_token],
    );
    return result.rows[0].id;
  }

  private async updateDelivery(
    deliveryId: string,
    status: 'sent' | 'failed' | 'skipped',
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE notification_deliveries SET
         status = $2, provider_message_id = COALESCE($3, provider_message_id), last_error = $4,
         sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, status, providerMessageId, error],
    );
  }

  private async finishEvent(id: string, status: 'sent' | 'failed', error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE notification_events SET
         status = $2, last_error = $3, updated_at = NOW(),
         sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
       WHERE id = $1`,
      [id, status, error],
    );
  }

  private async markDeviceHealthy(deviceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_devices SET failure_count = 0, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND (failure_count <> 0 OR last_error IS NOT NULL)`,
      [deviceId],
    );
  }

  private async disableDevice(deviceId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_devices SET
         enabled = false, disabled_at = NOW(), last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [deviceId, error],
    );
    this.logger.warn(`Wyłączono nieaktualne urządzenie push (${deviceId}): ${error}`);
  }

  private async recordDeviceFailure(deviceId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_devices SET
         failure_count = failure_count + 1, last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [deviceId, error],
    );
  }

  private safeMessage(error: unknown): string {
    return typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message).slice(0, 240)
      : 'Nieznany błąd';
  }
}
