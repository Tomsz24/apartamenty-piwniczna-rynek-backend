import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { AccessCodesService } from '../access-codes/access-codes.service';
import { HostexService } from '../hostex/hostex.service';
import {
  ArrivalDeliveryChannel,
  arrivalDeliveryChannel,
  classifyHostexSendError,
  hasUnfilledPlaceholders,
  renderArrivalMessage,
  ARRIVAL_TEMPLATE_PLACEHOLDERS,
  arrivalTemplateError,
} from './arrival-message.domain';

export type ArrivalTemplate = {
  apartmentId: string;
  body: string;
  updatedAt: string | null;
  placeholders: { key: string; label: string }[];
};

export type ArrivalMessagePreview = {
  reservationId: string;
  channel: ArrivalDeliveryChannel;
  autoSend: boolean;
  guestName: string | null;
  guestPhone: string | null;
  text: string | null;
  missingReason: string | null;
  mapImageUrl: string | null;
  sentAt: string | null;
  delivery: { status: string; imageSent: boolean; lastError: string | null; updatedAt: string } | null;
};

type StayContext = {
  id: string;
  status: string;
  origin: string;
  startDate: string;
  guestName: string | null;
  guestPhone: string | null;
  channelType: string | null;
  conversationId: string | null;
  timeZone: string;
  sentAt: string | null;
  label: string;
  apartmentId: string;
  templateBody: string | null;
  attachmentBucket: string | null;
  attachmentPath: string | null;
};

// Definite failures (e.g. no code yet) are retried by the next runs until 13:30.
const MAX_ATTEMPTS = 8;
// A delivery still "sending" after this long was interrupted (e.g. a restart mid-send).
const STALE_SENDING_MINUTES = 15;

/**
 * Arrival message with the door code and the map. Channel stays get it
 * automatically in the Hostex chat at 10:00 (Europe/Warsaw); manual stays are
 * sent by the owner via iMessage using the same rendered text.
 */
@Injectable()
export class ArrivalMessagesService {
  private readonly logger = new Logger(ArrivalMessagesService.name);
  private readonly autoSendEnabled: boolean;
  private readonly supabaseUrl: string;
  private busy = false;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly accessCodes: AccessCodesService,
    private readonly hostex: HostexService,
    configService: ConfigService,
  ) {
    this.autoSendEnabled =
      configService.get<string>('ARRIVAL_MESSAGE_AUTO_SEND_ENABLED')?.trim().toLowerCase() === 'true';
    this.supabaseUrl = (configService.get<string>('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  }

  async preview(reservationId: string): Promise<ArrivalMessagePreview> {
    const stay = await this.loadStay(reservationId);
    const channel = arrivalDeliveryChannel(stay);
    const { text, missingReason } = await this.render(stay);
    const delivery = await this.pool.query(
      `SELECT status, image_sent, last_error, updated_at FROM arrival_message_deliveries
       WHERE reservation_id = $1 AND stay_start_date = $2::date`,
      [stay.id, stay.startDate],
    );
    const row = delivery.rows[0];
    return {
      reservationId: stay.id,
      channel,
      autoSend: channel === 'hostex_chat' && this.autoSendEnabled,
      guestName: stay.guestName,
      guestPhone: stay.guestPhone,
      text,
      missingReason,
      mapImageUrl: this.mapUrl(stay),
      sentAt: stay.sentAt,
      delivery: row
        ? {
            status: row.status,
            imageSent: row.image_sent,
            lastError: row.last_error,
            updatedAt: new Date(row.updated_at).toISOString(),
          }
        : null,
    };
  }

  async getTemplate(apartmentId: string): Promise<ArrivalTemplate> {
    await this.assertApartment(apartmentId);
    const result = await this.pool.query(
      `SELECT body, updated_at FROM apartment_message_templates
       WHERE apartment_id = $1 AND message_type = 'arrival'`,
      [apartmentId],
    );
    return this.templateDto(apartmentId, result.rows[0]);
  }

  /** Replaces the arrival text; the map attachment and other settings stay as they are. */
  async saveTemplate(apartmentId: string, body: string): Promise<ArrivalTemplate> {
    const error = arrivalTemplateError(body);
    if (error) throw new BadRequestException(error);
    await this.assertApartment(apartmentId);
    const result = await this.pool.query(
      `INSERT INTO apartment_message_templates (apartment_id, message_type, body)
       VALUES ($1, 'arrival', $2)
       ON CONFLICT (apartment_id, message_type) DO UPDATE SET
         body = EXCLUDED.body, is_active = true, updated_at = NOW()
       RETURNING body, updated_at`,
      [apartmentId, body.trim()],
    );
    this.logger.log(`Zmieniono szablon wiadomości przyjazdowej (${apartmentId})`);
    return this.templateDto(apartmentId, result.rows[0]);
  }

  private async assertApartment(apartmentId: string): Promise<void> {
    const result = await this.pool.query(`SELECT 1 FROM apartments WHERE id = $1`, [apartmentId]);
    if (result.rows.length === 0) throw new NotFoundException('Apartament nie istnieje');
  }

  private templateDto(apartmentId: string, row?: { body: string; updated_at: Date }): ArrivalTemplate {
    return {
      apartmentId,
      body: row?.body ?? '',
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
      placeholders: ARRIVAL_TEMPLATE_PLACEHOLDERS.map((item) => ({ ...item })),
    };
  }

  /** Every half hour from 10:00 to 13:30; later runs only pick up stays not yet handled. */
  @Cron('0,30 10-13 * * *', { timeZone: 'Europe/Warsaw' })
  async handleScheduledSend(): Promise<void> {
    if (!this.autoSendEnabled || this.busy) return;
    this.busy = true;
    try {
      await this.releaseStaleSending();
      const due = await this.pool.query(
        `SELECT reservation.id
         FROM reservations AS reservation
         JOIN apartments AS apartment ON apartment.id = reservation.apartment_id
         WHERE reservation.status = 'confirmed'
           AND reservation.origin = 'hostex'
           AND reservation.arrival_message_sent_at IS NULL
           AND reservation.start_date = (NOW() AT TIME ZONE apartment.access_code_time_zone)::date
           AND reservation.metadata->>'conversationId' IS NOT NULL
           AND COALESCE(reservation.metadata->>'channelType', 'hostex_direct') <> 'hostex_direct'
           AND NOT EXISTS (
             SELECT 1 FROM arrival_message_deliveries AS delivery
             WHERE delivery.reservation_id = reservation.id
               AND delivery.stay_start_date = reservation.start_date
               AND (delivery.status IN ('sending', 'sent', 'uncertain') OR delivery.attempts >= $1)
           )
         ORDER BY reservation.start_date, reservation.id`,
        [MAX_ATTEMPTS],
      );
      for (const row of due.rows) {
        await this.sendViaHostex(row.id, 'automation').catch((error) =>
          this.logger.error(`Wiadomość przyjazdowa (${row.id}) nie została obsłużona: ${this.safe(error)}`),
        );
      }
    } catch (error) {
      this.logger.error(`Automatyczne wiadomości przyjazdowe nie działają: ${this.safe(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Sends text and map to the Hostex chat; used by the schedule and by "send now" in the app. */
  async sendViaHostex(reservationId: string, triggeredBy: string): Promise<ArrivalMessagePreview> {
    const stay = await this.loadStay(reservationId);
    if (arrivalDeliveryChannel(stay) !== 'hostex_chat' || !stay.conversationId) {
      throw new BadRequestException('Ta rezerwacja nie ma czatu kanału — wyślij wiadomość przez iMessage');
    }
    if (stay.status !== 'confirmed') {
      throw new ConflictException('Wiadomość wysyłamy tylko dla potwierdzonej rezerwacji');
    }
    if (stay.sentAt) throw new ConflictException('Wiadomość przyjazdowa została już wysłana');
    if (!(await this.claim(stay, triggeredBy))) {
      throw new ConflictException('Wiadomość jest właśnie wysyłana albo wymaga sprawdzenia czatu');
    }

    // A render error turns into missingReason, so the delivery ends as retryable "failed".
    const { text, missingReason } = await this.render(stay);
    if (!text) {
      await this.finish(stay, 'failed', false, missingReason);
      await this.notify(stay, 'failed', 'Nie wysłano wiadomości przyjazdowej', missingReason ?? 'Brak treści');
      return this.preview(reservationId);
    }

    try {
      await this.hostex.sendMessage(stay.conversationId, text);
    } catch (error) {
      const outcome = classifyHostexSendError(error);
      await this.finish(stay, outcome, false, this.safe(error));
      await this.notify(
        stay,
        outcome,
        outcome === 'uncertain' ? 'Sprawdź czat z gościem' : 'Nie wysłano wiadomości przyjazdowej',
        outcome === 'uncertain'
          ? 'Hostex nie potwierdził wysyłki — sprawdź w czacie, czy wiadomość doszła.'
          : `Hostex odrzucił wiadomość: ${this.safe(error)}`,
      );
      return this.preview(reservationId);
    }

    // The text with the code is what matters; mark it sent before the map so a
    // failing image can never cause the text to be sent twice.
    await this.pool.query(
      `UPDATE reservations SET arrival_message_sent_at = NOW() WHERE id = $1 AND arrival_message_sent_at IS NULL`,
      [stay.id],
    );
    let imageSent = false;
    let imageError: string | null = null;
    try {
      const image = await this.loadMapJpeg(stay);
      if (image) {
        await this.hostex.sendImage(stay.conversationId, image);
        imageSent = true;
      }
    } catch (error) {
      imageError = `Mapka nie została wysłana: ${this.safe(error)}`;
    }
    await this.finish(stay, 'sent', imageSent, imageError);
    await this.notify(
      stay,
      'sent',
      imageError ? 'Wysłano wiadomość, ale bez mapki' : 'Wysłano wiadomość przyjazdową',
      imageError ?? stay.label,
    );
    this.logger.log(`Wysłano wiadomość przyjazdową przez Hostex (${stay.id}, ${triggeredBy})`);
    return this.preview(reservationId);
  }

  private async render(stay: StayContext): Promise<{ text: string | null; missingReason: string | null }> {
    try {
      return await this.renderOrThrow(stay);
    } catch (error) {
      return { text: null, missingReason: `Nie udało się przygotować treści: ${this.safe(error)}` };
    }
  }

  private async renderOrThrow(stay: StayContext): Promise<{ text: string | null; missingReason: string | null }> {
    if (!stay.templateBody) return { text: null, missingReason: 'Apartament nie ma szablonu wiadomości przyjazdowej' };
    const page = await this.accessCodes.list({ reservationId: stay.id, limit: 10 } as never);
    const code = page.items.find((item) => item.status === 'active');
    if (!code) return { text: null, missingReason: 'Rezerwacja nie ma jeszcze aktywnego kodu do drzwi' };
    const text = renderArrivalMessage(stay.templateBody, {
      accessCode: code.code,
      validFrom: new Date(code.validFrom),
      validUntil: new Date(code.validUntil),
      timeZone: stay.timeZone,
    });
    if (hasUnfilledPlaceholders(text)) {
      return { text: null, missingReason: 'Szablon zawiera nieznane pola do uzupełnienia' };
    }
    return { text, missingReason: null };
  }

  /**
   * A crash between claiming and finishing leaves "sending" forever. We cannot tell whether
   * Hostex got the message, so hand it to the owner as "uncertain" rather than resend.
   */
  private async releaseStaleSending(): Promise<void> {
    const stale = await this.pool.query(
      `UPDATE arrival_message_deliveries
       SET status = 'uncertain', updated_at = NOW(),
           last_error = 'Wysyłka została przerwana — sprawdź w czacie, czy wiadomość doszła.'
       WHERE status = 'sending' AND updated_at < NOW() - make_interval(mins => $1)
       RETURNING reservation_id, stay_start_date::text AS stay_start_date`,
      [STALE_SENDING_MINUTES],
    );
    for (const row of stale.rows) {
      this.logger.warn(`Przerwana wysyłka wiadomości przyjazdowej (${row.reservation_id}) — wymaga sprawdzenia`);
      try {
        const stay = await this.loadStay(row.reservation_id);
        // Automation will not touch it again, so the owner has to hear about it.
        await this.notify(
          { ...stay, startDate: row.stay_start_date },
          'uncertain',
          'Sprawdź czat z gościem',
          'Wysyłka wiadomości przyjazdowej została przerwana — sprawdź w czacie, czy wiadomość doszła.',
        );
      } catch (error) {
        this.logger.error(`Nie udało się powiadomić o przerwanej wysyłce (${row.reservation_id}): ${this.safe(error)}`);
      }
    }
  }

  private async claim(stay: StayContext, triggeredBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO arrival_message_deliveries (reservation_id, stay_start_date, triggered_by)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (reservation_id, stay_start_date) DO UPDATE SET
         status = 'sending', attempts = arrival_message_deliveries.attempts + 1,
         triggered_by = EXCLUDED.triggered_by, last_error = NULL, updated_at = NOW()
       WHERE arrival_message_deliveries.status = 'failed'
         AND arrival_message_deliveries.attempts < $4
       RETURNING id`,
      [stay.id, stay.startDate, triggeredBy, MAX_ATTEMPTS],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async finish(
    stay: StayContext,
    status: 'sent' | 'failed' | 'uncertain',
    imageSent: boolean,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE arrival_message_deliveries SET
         status = $3, image_sent = $4, last_error = $5, updated_at = NOW(),
         sent_at = CASE WHEN $3 = 'sent' THEN NOW() ELSE sent_at END
       WHERE reservation_id = $1 AND stay_start_date = $2::date`,
      [stay.id, stay.startDate, status, imageSent, error],
    );
  }

  private async notify(
    stay: StayContext,
    outcome: 'sent' | 'failed' | 'uncertain',
    title: string,
    body: string,
  ): Promise<void> {
    const sent = outcome === 'sent';
    // One push per stay and outcome, however many retries run.
    await this.pool.query(
      `INSERT INTO notification_events (
         dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        `arrival_message:${stay.id}:${stay.startDate}:${outcome}`,
        sent ? 'arrival_message_sent' : 'arrival_message_failed',
        sent ? 'low' : 'critical',
        stay.apartmentId,
        stay.id,
        title,
        body,
        JSON.stringify({ reservationId: stay.id, conversationId: stay.conversationId }),
      ],
    );
  }

  private async loadMapJpeg(stay: StayContext): Promise<string | null> {
    const url = this.mapUrl(stay);
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`pobranie mapki zwróciło HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  private mapUrl(stay: StayContext): string | null {
    if (!this.supabaseUrl || !stay.attachmentBucket || !stay.attachmentPath) return null;
    const path = stay.attachmentPath.split('/').map(encodeURIComponent).join('/');
    return `${this.supabaseUrl}/storage/v1/object/public/${encodeURIComponent(stay.attachmentBucket)}/${path}`;
  }

  private async loadStay(reservationId: string): Promise<StayContext> {
    const result = await this.pool.query(
      `SELECT reservation.id, reservation.status, reservation.origin,
              reservation.start_date::text AS start_date, reservation.guest_name, reservation.guest_phone,
              reservation.metadata->>'channelType' AS channel_type,
              reservation.metadata->>'conversationId' AS conversation_id,
              reservation.arrival_message_sent_at, reservation.apartment_id,
              apartment.access_code_time_zone, notification_stay_label(reservation) AS label,
              template.body AS template_body, template.attachment_bucket_id, template.attachment_path
       FROM reservations AS reservation
       JOIN apartments AS apartment ON apartment.id = reservation.apartment_id
       LEFT JOIN apartment_message_templates AS template
         ON template.apartment_id = reservation.apartment_id
        AND template.message_type = 'arrival' AND template.is_active = true
       WHERE reservation.id = $1`,
      [reservationId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Rezerwacja nie istnieje');
    return {
      id: row.id,
      status: row.status,
      origin: row.origin,
      startDate: row.start_date,
      guestName: row.guest_name ?? null,
      guestPhone: row.guest_phone ?? null,
      channelType: row.channel_type ?? null,
      conversationId: row.conversation_id ?? null,
      timeZone: row.access_code_time_zone ?? 'Europe/Warsaw',
      sentAt: row.arrival_message_sent_at ? new Date(row.arrival_message_sent_at).toISOString() : null,
      label: row.label ?? '',
      apartmentId: row.apartment_id,
      templateBody: row.template_body ?? null,
      attachmentBucket: row.attachment_bucket_id ?? null,
      attachmentPath: row.attachment_path ?? null,
    };
  }

  private safe(error: unknown): string {
    const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
    return (message || 'nieznany błąd')
      .replace(/(?:Bearer|Hostex-Access-Token)\s+\S+/gi, '[ukryte]')
      .replace(/https?:\/\/\S+/gi, '[adres]')
      .slice(0, 200);
  }
}
