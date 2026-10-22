import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { HostexConversationDetails } from '../hostex/hostex.types';
import { latestIncomingMessage } from './notification.domain';

// Reservation changes and access-code errors are produced by database triggers
// (migration 20261021180000). This service adds the time-based events and the
// Hostex message events that need data from outside the database.
@Injectable()
export class NotificationProducerService {
  private readonly logger = new Logger(NotificationProducerService.name);
  private readonly enabled: boolean;
  private readonly reminderTime: string;
  private readonly missingCodeLeadMinutes: number;
  private busy = false;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    configService: ConfigService,
  ) {
    this.enabled = configService.get<string>('NOTIFICATIONS_ENABLED')?.trim().toLowerCase() === 'true';
    const reminder = configService.get<string>('NOTIFICATION_ARRIVAL_REMINDER_TIME')?.trim() ?? '';
    this.reminderTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(reminder) ? reminder : '10:00';
    const lead = Number(configService.get<string>('NOTIFICATION_MISSING_CODE_LEAD_MINUTES'));
    this.missingCodeLeadMinutes = Number.isInteger(lead) && lead >= 0 && lead <= 720 ? lead : 120;
  }

  @Cron('*/5 * * * *')
  async handleScheduledChecks(): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      await this.enqueueArrivalReminders();
      await this.enqueueMissingAccessCodes();
    } catch (error) {
      this.logger.error(`Nie udało się przygotować powiadomień okresowych: ${this.safeMessage(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Escalating reminders while the arrival message is not marked as sent:
   * first reminder (default 10:00), 13:00 and 15:00 (check-in). Only the latest
   * reached stage is sent, so a restart never fires several at once. Channel
   * stays get the message automatically at 10:00, so they start at 13:00.
   */
  async enqueueArrivalReminders(): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO notification_events (
         dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
       )
       SELECT 'arrival_message_reminder:' || reservation.id || ':' || reservation.start_date || ':' || stage.n,
              'arrival_message_reminder', stage.priority, reservation.apartment_id, reservation.id,
              stage.title, notification_stay_label(reservation),
              jsonb_build_object('reservationId', reservation.id)
       FROM reservations AS reservation
       JOIN apartments AS apartment ON apartment.id = reservation.apartment_id
       CROSS JOIN LATERAL (
         SELECT step.n, step.priority, step.title
         FROM (VALUES
           (1, $1::time, 'normal', 'Wyślij wiadomość przyjazdową'),
           (2, TIME '13:00', 'high', 'Wiadomość przyjazdowa nadal niewysłana'),
           (3, TIME '15:00', 'critical', 'Gość może już być na miejscu — wyślij kod')
         ) AS step(n, at, priority, title)
         WHERE (NOW() AT TIME ZONE apartment.access_code_time_zone) >= reservation.start_date + step.at
           AND NOT (
             step.n = 1
             AND reservation.origin = 'hostex'
             AND reservation.metadata->>'conversationId' IS NOT NULL
             AND COALESCE(reservation.metadata->>'channelType', 'hostex_direct') <> 'hostex_direct'
           )
         ORDER BY step.n DESC
         LIMIT 1
       ) AS stage
       WHERE reservation.status = 'confirmed'
         AND reservation.origin IN ('manual', 'hostex', 'booking_email')
         AND reservation.arrival_message_sent_at IS NULL
         AND reservation.start_date = (NOW() AT TIME ZONE apartment.access_code_time_zone)::date
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [this.reminderTime],
    );
    return result.rowCount ?? 0;
  }

  async enqueueMissingAccessCodes(): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO notification_events (
         dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
       )
       SELECT 'access_code_missing:' || reservation.id || ':' || reservation.start_date,
              'access_code_missing', 'critical', reservation.apartment_id, reservation.id,
              'Brak kodu do drzwi', notification_stay_label(reservation),
              jsonb_build_object('reservationId', reservation.id)
       FROM reservations AS reservation
       JOIN apartments AS apartment ON apartment.id = reservation.apartment_id
       WHERE reservation.status = 'confirmed'
         AND reservation.origin IN ('manual', 'hostex', 'booking_email')
         AND reservation.start_date = (NOW() AT TIME ZONE apartment.access_code_time_zone)::date
         AND (NOW() AT TIME ZONE apartment.access_code_time_zone)
             >= reservation.start_date + apartment.access_code_check_in_time - make_interval(mins => $1)
         AND EXISTS (
           SELECT 1 FROM apartment_access_devices AS device
           WHERE device.apartment_id = reservation.apartment_id
             AND device.provider = 'ttlock'
             AND device.scope = 'apartment'
             AND device.active = true
         )
         AND NOT EXISTS (
           SELECT 1 FROM reservation_access_codes AS code
           WHERE code.reservation_id = reservation.id
             AND code.status <> 'revoked'
         )
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [this.missingCodeLeadMinutes],
    );
    return result.rowCount ?? 0;
  }

  /** Creates a `new_message` event for the newest guest message; returns false when there is none. */
  async enqueueHostexMessage(conversation: HostexConversationDetails): Promise<boolean> {
    const message = latestIncomingMessage(conversation);
    if (!message) return false;
    const reservation = await this.pool.query(
      `SELECT id, apartment_id FROM reservations
       WHERE metadata->>'conversationId' = $1
       ORDER BY start_date DESC
       LIMIT 1`,
      [conversation.id],
    );
    const linked = reservation.rows[0];
    await this.pool.query(
      `INSERT INTO notification_events (
         dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
       ) VALUES ($1, 'new_message', 'high', $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        `new_message:${conversation.id}:${message.messageId}`,
        linked?.apartment_id ?? null,
        linked?.id ?? null,
        message.title,
        message.body,
        JSON.stringify({
          conversationId: conversation.id,
          ...(linked ? { reservationId: linked.id } : {}),
        }),
      ],
    );
    return true;
  }

  private safeMessage(error: unknown): string {
    return typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message).slice(0, 240)
      : 'Nieznany błąd';
  }
}
