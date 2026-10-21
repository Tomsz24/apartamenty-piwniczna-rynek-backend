import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { NotificationProducerService } from '../notifications/notification-producer.service';
import { HostexService } from './hostex.service';
import { HostexSyncService } from './hostex-sync.service';
import {
  hostexWebhookAction,
  hostexWebhookRetryDelayMinutes,
  ParsedHostexWebhook,
  verifyHostexWebhookSecret,
} from './hostex-webhook.domain';

type InboxRow = {
  id: string;
  event_type: string;
  event_id: string | null;
  reservation_code: string | null;
  conversation_id: string | null;
  attempts: number;
};

const MAX_ATTEMPTS = 5;
const MAX_EVENTS_PER_RUN = 20;

@Injectable()
export class HostexWebhookService {
  private readonly logger = new Logger(HostexWebhookService.name);
  private readonly secret: string;
  private running: Promise<void> | null = null;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly syncService: HostexSyncService,
    private readonly hostexService: HostexService,
    private readonly notificationProducer: NotificationProducerService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('HOSTEX_WEBHOOK_SECRET')?.trim() ?? '';
  }

  isEnabled(): boolean {
    return this.secret.length > 0;
  }

  verifySecret(received: unknown): boolean {
    return verifyHostexWebhookSecret(this.secret, received);
  }

  async receive(event: ParsedHostexWebhook): Promise<{ duplicate: boolean }> {
    const inserted = await this.pool.query(
      `INSERT INTO hostex_webhook_events (
         dedupe_key, event_id, event_type, reservation_code, stay_code, property_id,
         conversation_id, payload_keys
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [event.dedupeKey, event.eventId, event.eventType, event.reservationCode,
        event.stayCode, event.propertyId, event.conversationId, event.payloadKeys],
    );
    const duplicate = inserted.rowCount === 0;
    this.logger.log(
      `Webhook Hostex ${event.eventType}${event.eventId ? ` (${event.eventId})` : ''}` +
      (duplicate ? ': duplikat, pomijam' : ': zapisany w kolejce'),
    );
    // Hostex waits at most 5 s for the response, so processing must not block it.
    if (!duplicate) void this.processPending();
    return { duplicate };
  }

  @Cron('*/1 * * * *')
  async handleScheduledProcessing(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.processPending();
  }

  processPending(): Promise<void> {
    // Callers arriving mid-run share the in-flight drain instead of starting a second one.
    this.running ??= this.drainPending().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drainPending(): Promise<void> {
    try {
      for (let index = 0; index < MAX_EVENTS_PER_RUN; index += 1) {
        const event = await this.claimNext();
        if (!event) return;
        await this.processEvent(event);
      }
    } catch (error) {
      this.logger.error(`Kolejka webhooków Hostex nie działa: ${this.safeErrorMessage(error)}`);
    }
  }

  async getStatus() {
    const result = await this.pool.query(
      `SELECT status, COUNT(*)::int AS count, MAX(received_at) AS last_received_at
       FROM hostex_webhook_events
       WHERE received_at > NOW() - interval '7 days'
       GROUP BY status`,
    );
    const counts = { pending: 0, processed: 0, ignored: 0, failed: 0 };
    let lastReceivedAt: string | null = null;
    for (const row of result.rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
      const received = row.last_received_at ? new Date(row.last_received_at).toISOString() : null;
      if (received && (!lastReceivedAt || received > lastReceivedAt)) lastReceivedAt = received;
    }
    return { enabled: this.isEnabled(), lastReceivedAt, last7Days: counts };
  }

  private async claimNext(): Promise<InboxRow | null> {
    // Leasing the row (pushing next_attempt_at forward) lets a crashed run be
    // retried later and keeps a second backend instance from taking the same event.
    const result = await this.pool.query<InboxRow>(
      `UPDATE hostex_webhook_events SET
         attempts = attempts + 1,
         next_attempt_at = NOW() + interval '10 minutes'
       WHERE id = (
         SELECT id FROM hostex_webhook_events
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY received_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, event_type, event_id, reservation_code, conversation_id, attempts`,
    );
    return result.rows[0] ?? null;
  }

  private async processEvent(event: InboxRow): Promise<void> {
    const action = hostexWebhookAction(event.event_type);
    try {
      if (action === 'sync_reservation') {
        await this.syncReservation(event.reservation_code);
      } else if (action === 'new_message') {
        await this.notifyNewMessage(event.conversation_id);
      } else if (action === 'authorization_revoked') {
        this.logger.error(
          'Hostex cofnął autoryzację API. Webhooki i synchronizacja wymagają ponownego połączenia i nowego sekretu.',
        );
      }
      await this.pool.query(
        `UPDATE hostex_webhook_events SET
           status = $2, processed_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [event.id, action === 'ignore' ? 'ignored' : 'processed'],
      );
    } catch (error) {
      const message = this.safeErrorMessage(error);
      const failed = event.attempts >= MAX_ATTEMPTS;
      await this.pool.query(
        `UPDATE hostex_webhook_events SET
           status = $2, last_error = $3,
           next_attempt_at = NOW() + make_interval(mins => $4)
         WHERE id = $1`,
        [event.id, failed ? 'failed' : 'pending', message,
          hostexWebhookRetryDelayMinutes(event.attempts)],
      );
      this.logger.error(
        `Webhook Hostex ${event.event_type} (próba ${event.attempts}/${MAX_ATTEMPTS}) ` +
        `nie został przetworzony: ${message}`,
      );
    }
  }

  private async syncReservation(reservationCode: string | null): Promise<void> {
    // The webhook body is only a trigger; the current state always comes from the API.
    if (reservationCode) {
      const result = await this.syncService.syncReservations(true, { reservationCode });
      if (result.fetched > 0) return;
    }
    // Without a usable code (or when the filter finds nothing) fall back to a
    // full reconciliation; it is idempotent and cheap for two apartments.
    await this.syncService.syncReservations(true);
  }

  private async notifyNewMessage(conversationId: string | null): Promise<void> {
    if (!conversationId) {
      this.logger.warn('Webhook message_created bez conversation_id — pomijam powiadomienie');
      return;
    }
    // Like reservations, the payload is only a trigger: read the conversation to
    // get the actual message and skip ones we sent ourselves.
    const conversation = await this.hostexService.getConversation(conversationId);
    await this.notificationProducer.enqueueHostexMessage(conversation);
  }

  private safeErrorMessage(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return 'Nieznany błąd przetwarzania webhooka';
    }
    return String(error.message)
      .replace(/(?:Bearer|Hostex-Access-Token)\s+\S+/gi, '[dane uwierzytelniające ukryte]')
      .replace(/https?:\/\/\S+/gi, '[adres ukryty]')
      .slice(0, 240);
  }
}
