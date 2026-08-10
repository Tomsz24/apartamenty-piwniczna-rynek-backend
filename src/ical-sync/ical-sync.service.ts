import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import * as ical from 'node-ical';

interface IcalEvent {
  uid: string;
  start: Date;
  end: Date;
  summary?: string;
}

interface ApartmentConfig {
  id: string;
  name: string;
  icalToken: string;
}

@Injectable()
export class IcalSyncService implements OnModuleInit {
  private readonly logger = new Logger(IcalSyncService.name);
  private apartments: ApartmentConfig[] = [];

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Przy starcie aplikacji - załaduj konfigurację i wykonaj pierwszą synchronizację
   */
  async onModuleInit() {
    await this.loadApartmentsConfig();
    await this.syncAllCalendars();
  }

  /** Automatyczna synchronizacja co 30 minut. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCron() {
    this.logger.log('⏰ Starting scheduled iCal sync...');
    await this.syncAllCalendars();
  }

  /**
   * Synchronizuje wszystkie kalendarze
   */
  async syncAllCalendars(): Promise<void> {
    for (const apartment of this.apartments) {
      try {
        await this.syncApartmentCalendar(apartment);
        this.logger.log(`✅ Synced: ${apartment.name}`);
      } catch (error) {
        this.logger.error(`❌ Failed to sync ${apartment.name}:`, error.message);
      }
    }
  }

  /**
   * Synchronizuje kalendarz jednego apartamentu
   */
  private async syncApartmentCalendar(apartment: ApartmentConfig): Promise<void> {
    const icalUrl = `https://ical.booking.com/v1/export?t=${apartment.icalToken}`;

    const events = await this.fetchAndParseIcal(icalUrl);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const relevantEvents = events.filter(
      (event) => new Date(event.end) >= today,
    );

    await this.saveExternalBookings(apartment.id, relevantEvents);
  }

  /**
   * Pobiera i parsuje plik iCal
   */
  private async fetchAndParseIcal(url: string): Promise<IcalEvent[]> {
    const data = await ical.async.fromURL(url);
    const events: IcalEvent[] = [];

    for (const key in data) {
      const event = data[key];

      if (event.type === 'VEVENT' && event.start && event.end) {
        events.push({
          uid: event.uid || key,
          start: new Date(event.start),
          end: new Date(event.end),
          summary: event.summary,
        });
      }
    }

    return events;
  }

  /**
   * iCal jest sygnałem pomocniczym, a nie właścicielem rezerwacji.
   * UID zapisujemy jako alias. Zniknięcie UID nigdy nie usuwa rezerwacji ani notatki.
   */
  private async saveExternalBookings(
    apartmentId: string,
    events: IcalEvent[],
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [apartmentId]);

      const currentUids = [...new Set(events.map((event) => event.uid))];

      for (const event of events) {
        const startDate = this.formatDateLocal(event.start);
        const endDate = this.formatDateLocal(event.end);
        const existingRef = await client.query(
          `
            SELECT reservation_id
            FROM reservation_source_refs
            WHERE apartment_id = $1
              AND source_system = 'booking_ical'
              AND external_id = $2
            FOR UPDATE
          `,
          [apartmentId, event.uid],
        );

        let reservationId: string | null = existingRef.rows[0]?.reservation_id ?? null;

        if (!reservationId) {
          reservationId = await this.findUniqueReservationMatch(client, {
            apartmentId,
            startDate,
            endDate,
            currentUids,
          });
        }

        if (!reservationId) {
          const inserted = await client.query(
            `
              INSERT INTO reservations (
                apartment_id,
                origin,
                status,
                start_date,
                end_date,
                created_by,
                last_seen_at,
                metadata
              )
              VALUES ($1, 'booking_ical', 'confirmed', $2, $3, 'ical-sync', NOW(), $4::jsonb)
              RETURNING id
            `,
            [
              apartmentId,
              startDate,
              endDate,
              JSON.stringify({ summary: event.summary ?? null }),
            ],
          );
          reservationId = inserted.rows[0].id;
        } else {
          await client.query(
            `
              UPDATE reservations
              SET start_date = CASE WHEN origin = 'booking_ical' THEN $2::date ELSE start_date END,
                  end_date = CASE WHEN origin = 'booking_ical' THEN $3::date ELSE end_date END,
                  status = CASE
                    WHEN origin = 'booking_ical' AND status = 'needs_review' THEN 'confirmed'
                    ELSE status
                  END,
                  last_seen_at = NOW(),
                  updated_at = CASE
                    WHEN origin = 'booking_ical'
                         AND (start_date <> $2::date OR end_date <> $3::date)
                      THEN NOW()
                    ELSE updated_at
                  END,
                  version = CASE
                    WHEN origin = 'booking_ical'
                         AND (start_date <> $2::date OR end_date <> $3::date)
                      THEN version + 1
                    ELSE version
                  END
              WHERE id = $1
            `,
            [reservationId, startDate, endDate],
          );
        }

        await client.query(
          `
            INSERT INTO reservation_source_refs (
              reservation_id,
              apartment_id,
              source_system,
              external_id,
              is_current,
              last_seen_at,
              raw_data
            )
            VALUES ($1, $2, 'booking_ical', $3, true, NOW(), $4::jsonb)
            ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
              reservation_id = EXCLUDED.reservation_id,
              is_current = true,
              last_seen_at = NOW(),
              missing_since = NULL,
              raw_data = EXCLUDED.raw_data
          `,
          [
            reservationId,
            apartmentId,
            event.uid,
            JSON.stringify({ startDate, endDate, summary: event.summary ?? null }),
          ],
        );
      }

      await client.query(
        `
          UPDATE reservation_source_refs AS refs
          SET is_current = false,
              missing_since = COALESCE(refs.missing_since, NOW())
          FROM reservations AS reservation
          WHERE refs.reservation_id = reservation.id
            AND refs.apartment_id = $1
            AND refs.source_system = 'booking_ical'
            AND reservation.end_date >= CURRENT_DATE
            AND NOT (refs.external_id = ANY($2::text[]))
        `,
        [apartmentId, currentUids],
      );

      // Po dwóch pełnych cyklach synchronizacji zgłaszamy brak do weryfikacji.
      // Nadal niczego nie anulujemy ani nie kasujemy automatycznie.
      await client.query(
        `
          UPDATE reservations AS reservation
          SET status = 'needs_review',
              updated_at = NOW(),
              version = version + 1
          WHERE reservation.apartment_id = $1
            AND reservation.origin = 'booking_ical'
            AND reservation.status = 'confirmed'
            AND reservation.end_date >= CURRENT_DATE
            AND EXISTS (
              SELECT 1
              FROM reservation_source_refs AS missing_ref
              WHERE missing_ref.reservation_id = reservation.id
                AND missing_ref.source_system = 'booking_ical'
                AND missing_ref.is_current = false
                AND missing_ref.missing_since <= NOW() - INTERVAL '60 minutes'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM reservation_source_refs AS current_ref
              WHERE current_ref.reservation_id = reservation.id
                AND current_ref.is_current = true
            )
        `,
        [apartmentId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findUniqueReservationMatch(
    client: import('pg').PoolClient,
    params: {
      apartmentId: string;
      startDate: string;
      endDate: string;
      currentUids: string[];
    },
  ): Promise<string | null> {
    const candidates = await client.query(
      `
        SELECT reservation.id,
               reservation.start_date,
               reservation.end_date
        FROM reservations AS reservation
        WHERE reservation.apartment_id = $1
          AND reservation.origin <> 'manual'
          AND reservation.status <> 'cancelled'
          AND reservation.start_date < $3::date
          AND reservation.end_date > $2::date
          AND NOT EXISTS (
            SELECT 1
            FROM reservation_source_refs AS seen_ref
            WHERE seen_ref.reservation_id = reservation.id
              AND seen_ref.source_system = 'booking_ical'
              AND seen_ref.external_id = ANY($4::text[])
          )
        ORDER BY
          (reservation.start_date = $2::date AND reservation.end_date = $3::date) DESC,
          reservation.updated_at DESC
      `,
      [params.apartmentId, params.startDate, params.endDate, params.currentUids],
    );

    const exact = candidates.rows.filter(
      (row) =>
        this.formatDateLocal(row.start_date) === params.startDate &&
        this.formatDateLocal(row.end_date) === params.endDate,
    );
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null;

    return candidates.rows.length === 1 ? candidates.rows[0].id : null;
  }

  /**
   * Formatuje datę bez konwersji do UTC
   */
  private formatDateLocal(date: Date | string): string {
    if (typeof date === 'string') {
      return date.split('T')[0];
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Ładuje konfigurację apartamentów z bazy i env
   */
  private async loadApartmentsConfig(): Promise<void> {
    const result = await this.pool.query(`
      SELECT id, name FROM apartments ORDER BY name
    `);

    const goryToken = this.configService.get<string>('ICAL_GORY_TOKEN');
    const rynekToken = this.configService.get<string>('ICAL_RYNEK_TOKEN');

    for (const row of result.rows) {
      const nameLower = row.name.toLowerCase();

      if (nameLower.includes('góry') && goryToken) {
        this.apartments.push({
          id: row.id,
          name: row.name,
          icalToken: goryToken,
        });
      } else if (nameLower.includes('rynek') && rynekToken) {
        this.apartments.push({
          id: row.id,
          name: row.name,
          icalToken: rynekToken,
        });
      }
    }

    this.logger.log(
      `📋 Loaded ${this.apartments.length} apartments for iCal sync`,
    );
  }

  /**
   * Ręczna synchronizacja (może być wywołana z endpointu admina)
   */
  async forceSync(): Promise<{ synced: number; errors: string[] }> {
    const errors: string[] = [];
    let synced = 0;

    for (const apartment of this.apartments) {
      try {
        await this.syncApartmentCalendar(apartment);
        synced++;
      } catch (error) {
        errors.push(`${apartment.name}: ${error.message}`);
      }
    }

    return { synced, errors };
  }
}
