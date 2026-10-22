import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool, PoolClient } from 'pg';
import { renderReservationEmail, ReservationEmailEvent } from './reservation-email.template';

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
// Each address gets its own copy of the email.
const MAX_RECIPIENTS = 10;

/** `RESERVATION_EMAIL_TO` holds one address or several separated by commas. */
export function recipientList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((address) => address.trim()).filter(Boolean))];
}

type EmailJob = ReservationEmailEvent & { id: string; attempts: number; request: any; first_attempt_at: string | null };

@Injectable()
export class ReservationEmailService implements OnModuleInit {
  private readonly logger = new Logger(ReservationEmailService.name);
  private busy = false;
  constructor(@Inject('PG_POOL') private readonly pool: Pool, private readonly config: ConfigService) {}

  onModuleInit() {
    if (this.config.get('RESERVATION_EMAIL_ENABLED') !== 'true') return;
    for (const name of ['RESEND_API_KEY', 'RESERVATION_EMAIL_FROM', 'RESERVATION_EMAIL_TO', 'RESERVATION_EMAIL_START_AT']) {
      if (!this.config.get<string>(name)?.trim()) throw new Error(`Missing ${name}`);
    }
    if (!Number.isFinite(Date.parse(this.config.get('RESERVATION_EMAIL_START_AT')))) throw new Error('Invalid RESERVATION_EMAIL_START_AT');
    if (!EMAIL.test(this.config.get('RESERVATION_EMAIL_FROM'))) throw new Error('Invalid RESERVATION_EMAIL_FROM: expected one email address');
    const recipients = recipientList(this.config.get('RESERVATION_EMAIL_TO'));
    if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS || !recipients.every((address) => EMAIL.test(address))) {
      throw new Error(`Invalid RESERVATION_EMAIL_TO: expected 1-${MAX_RECIPIENTS} email addresses separated by commas`);
    }
  }

  @Cron('*/30 * * * * *')
  async dispatch() {
    if (this.busy || this.config.get('RESERVATION_EMAIL_ENABLED') !== 'true') return;
    this.busy = true;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      // One job per tick bounds traffic; row locks also protect multiple backend instances.
      const result = await client.query<EmailJob>(
        `SELECT * FROM reservation_email_outbox
         WHERE status = 'pending' AND next_attempt_at <= NOW() AND created_at >= $1::timestamptz
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [this.config.get('RESERVATION_EMAIL_START_AT')],
      );
      const job = result.rows[0];
      if (!job) { await client.query('COMMIT'); return; }
      // Never resend an ambiguous request after Resend's 24-hour deduplication window.
      if (job.first_attempt_at && Date.now() - Date.parse(job.first_attempt_at) >= 23 * 60 * 60 * 1000) {
        await client.query(`UPDATE reservation_email_outbox SET status='failed', last_error='Idempotency window expired; verify in Resend before retrying' WHERE id=$1`, [job.id]);
        await client.query('COMMIT');
        this.logger.error(`Email ${job.id}: manual delivery verification required`);
        return;
      }
      const recipients = recipientList(this.config.get('RESERVATION_EMAIL_TO'));
      const message = {
        from: `Apartamenty Piwniczna Rynek <${this.config.get('RESERVATION_EMAIL_FROM')}>`,
        ...renderReservationEmail(job),
      };
      // A separate email per recipient (Resend batch), so nobody sees the other addresses.
      const request = job.request || (recipients.length === 1
        ? { ...message, to: recipients }
        : recipients.map((to) => ({ ...message, to: [to] })));
      const batch = Array.isArray(request);
      // Persist the exact body before the HTTP request, including recipient and template version.
      await client.query(`UPDATE reservation_email_outbox SET request=$2::jsonb, first_attempt_at=COALESCE(first_attempt_at,NOW()), attempts=attempts+1, next_attempt_at=NOW()+INTERVAL '2 minutes' WHERE id=$1`, [job.id, JSON.stringify(request)]);
      await client.query('COMMIT');
      // Reacquire the row before sending: a competing worker can only see it after the lease expires.
      await client.query('BEGIN');
      await client.query('SELECT id FROM reservation_email_outbox WHERE id=$1 FOR UPDATE', [job.id]);
      try {
        const response = await fetch(batch ? 'https://api.resend.com/emails/batch' : 'https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `reservation/${job.id}` },
          body: JSON.stringify(request), signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500 || response.status === 408;
          const retryAfter = Number(response.headers.get('retry-after'));
          throw Object.assign(new Error(`Resend HTTP ${response.status}`), { retryable, retryAfter });
        }
        const body = await response.json() as { id?: string; data?: Array<{ id?: string }> };
        const ids = (batch ? (body.data ?? []).map((item) => item.id) : [body.id]).filter((id): id is string => Boolean(id));
        if (ids.length === 0 || (batch && ids.length !== request.length)) throw new Error('Resend response missing message ID');
        await client.query(`UPDATE reservation_email_outbox SET status='sent', provider_message_id=$2, sent_at=NOW(), last_error=NULL WHERE id=$1`, [job.id, ids.join(',')]);
      } catch (error) {
        const terminal = error.retryable === false || job.attempts + 1 >= 12;
        const delay = Math.min(3600, Math.max(60 * 2 ** Math.min(job.attempts, 6), error.retryAfter || 0));
        // Provider bodies and guest details intentionally stay out of logs.
        const message = error.message?.startsWith('Resend HTTP ') ? error.message : 'Email delivery failed or unconfirmed';
        await client.query(`UPDATE reservation_email_outbox SET status=$2, last_error=$3, next_attempt_at=NOW()+($4 * INTERVAL '1 second') WHERE id=$1`, [job.id, terminal ? 'failed' : 'pending', message, delay]);
        this.logger.warn(`Email ${job.id}: ${message}${terminal ? ' (manual action required)' : ''}`);
      }
      await client.query('COMMIT');
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Reservation email queue unavailable; check database and migration');
    } finally {
      client?.release();
      this.busy = false;
    }
  }
}
