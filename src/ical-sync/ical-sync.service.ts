import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool, PoolClient } from 'pg';
import { ConfigService } from '@nestjs/config';
import * as ical from 'node-ical';
import { classifyRangeCoverage } from '../reservations/reservations.domain';

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

    await this.saveAvailabilityObservations(apartment.id, relevantEvents);
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
   * iCal jest tylko obserwacją zajętości Booking.com.
   * Nie tworzy rezerwacji, nie przechowuje notatek i nie decyduje o tożsamości pobytu.
   */
  private async saveAvailabilityObservations(
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
        const observationResult = await client.query(
          `
            INSERT INTO ical_availability_observations (
              apartment_id,
              source_system,
              external_id,
              start_date,
              end_date,
              summary,
              is_current,
              first_seen_at,
              last_seen_at,
              missing_since,
              raw_data
            )
            VALUES ($1, 'booking_ical', $2, $3, $4, $5, true, NOW(), NOW(), NULL, $6::jsonb)
            ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
              start_date = EXCLUDED.start_date,
              end_date = EXCLUDED.end_date,
              summary = EXCLUDED.summary,
              is_current = true,
              last_seen_at = NOW(),
              missing_since = NULL,
              raw_data = EXCLUDED.raw_data,
              updated_at = NOW()
            RETURNING id
          `,
          [
            apartmentId,
            event.uid,
            startDate,
            endDate,
            event.summary ?? null,
            JSON.stringify({ uid: event.uid, startDate, endDate, summary: event.summary ?? null }),
          ],
        );

        const observationId = observationResult.rows[0].id as string;
        const matches = await this.findOverlappingReservations(client, apartmentId, startDate, endDate);
        const coverage = classifyRangeCoverage(matches, startDate, endDate);
        const matchStatus =
          coverage === 'none'
            ? 'unmatched'
            : coverage === 'partial'
              ? 'conflict'
              : matches.length > 1
                ? 'matched_multiple'
                : 'matched_single';

        await client.query(
          `DELETE FROM ical_observation_reservation_matches WHERE observation_id = $1`,
          [observationId],
        );

        for (const match of matches) {
          await client.query(
            `
              INSERT INTO ical_observation_reservation_matches (
                observation_id,
                reservation_id,
                match_type
              )
              VALUES ($1, $2, $3)
              ON CONFLICT (observation_id, reservation_id) DO NOTHING
            `,
            [observationId, match.id, this.resolveMatchType(match, startDate, endDate)],
          );
        }

        await client.query(
          `
            UPDATE ical_availability_observations
            SET match_status = $2,
                matched_reservation_count = $3,
                updated_at = NOW()
            WHERE id = $1
          `,
          [observationId, matchStatus, matches.length],
        );

        if (matchStatus === 'unmatched') {
          await this.upsertReviewItem(client, {
            dedupeKey: `ical_unmatched_block:${observationId}`,
            apartmentId,
            observationId,
            kind: 'ical_unmatched_block',
            severity: 'warning',
            title: 'Blokada iCal bez rezerwacji w systemie',
            details: { externalId: event.uid, startDate, endDate, summary: event.summary ?? null },
          });
        } else if (matchStatus === 'conflict') {
          await this.upsertReviewItem(client, {
            dedupeKey: `ical_observation_conflict:${observationId}`,
            apartmentId,
            observationId,
            kind: 'ical_observation_conflict',
            severity: 'critical',
            title: 'Blokada iCal tylko częściowo pasuje do rezerwacji',
            details: {
              externalId: event.uid,
              startDate,
              endDate,
              summary: event.summary ?? null,
              matchedReservationIds: matches.map((match) => match.id),
            },
          });
        } else {
          await this.resolveReviewItems(client, [
            `ical_unmatched_block:${observationId}`,
            `ical_observation_conflict:${observationId}`,
          ]);
        }
      }

      await client.query(
        `
          UPDATE ical_availability_observations
          SET is_current = false,
              missing_since = COALESCE(missing_since, NOW()),
              match_status = 'stale',
              updated_at = NOW()
          WHERE apartment_id = $1
            AND source_system = 'booking_ical'
            AND is_current = true
            AND end_date >= CURRENT_DATE
            AND NOT (external_id = ANY($2::text[]))
        `,
        [apartmentId, currentUids],
      );

      await this.syncReservationCoverageAlerts(client, apartmentId);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findOverlappingReservations(
    client: PoolClient,
    apartmentId: string,
    startDate: string,
    endDate: string,
  ): Promise<Array<{ id: string; startDate: string; endDate: string }>> {
    const result = await client.query(
      `
        SELECT id, start_date, end_date
        FROM reservations AS reservation
        WHERE reservation.apartment_id = $1
          AND reservation.status <> 'cancelled'
          AND reservation.start_date < $3::date
          AND reservation.end_date > $2::date
        ORDER BY reservation.start_date, reservation.end_date, reservation.created_at
      `,
      [apartmentId, startDate, endDate],
    );

    return result.rows.map((row) => ({
      id: row.id,
      startDate: this.formatDateLocal(row.start_date),
      endDate: this.formatDateLocal(row.end_date),
    }));
  }

  private resolveMatchType(
    reservation: { startDate: string; endDate: string },
    observationStart: string,
    observationEnd: string,
  ): 'exact' | 'covered_by' | 'overlap' {
    if (reservation.startDate === observationStart && reservation.endDate === observationEnd) {
      return 'exact';
    }
    if (reservation.startDate <= observationStart && reservation.endDate >= observationEnd) {
      return 'covered_by';
    }
    return 'overlap';
  }

  private async upsertReviewItem(
    client: PoolClient,
    params: {
      dedupeKey: string;
      apartmentId: string;
      observationId?: string;
      reservationId?: string;
      kind:
        | 'ical_unmatched_block'
        | 'ical_observation_conflict'
        | 'reservation_missing_in_ical';
      severity: 'warning' | 'critical';
      title: string;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO reservation_review_items (
          dedupe_key,
          apartment_id,
          reservation_id,
          observation_id,
          kind,
          severity,
          status,
          title,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8::jsonb)
        ON CONFLICT (dedupe_key) DO UPDATE SET
          apartment_id = EXCLUDED.apartment_id,
          reservation_id = EXCLUDED.reservation_id,
          observation_id = EXCLUDED.observation_id,
          kind = EXCLUDED.kind,
          severity = EXCLUDED.severity,
          status = 'open',
          title = EXCLUDED.title,
          details = EXCLUDED.details,
          last_seen_at = NOW(),
          resolved_at = NULL,
          updated_at = NOW()
      `,
      [
        params.dedupeKey,
        params.apartmentId,
        params.reservationId ?? null,
        params.observationId ?? null,
        params.kind,
        params.severity,
        params.title,
        JSON.stringify(params.details),
      ],
    );
  }

  private async resolveReviewItems(client: PoolClient, dedupeKeys: string[]): Promise<void> {
    if (dedupeKeys.length === 0) return;
    await client.query(
      `
        UPDATE reservation_review_items
        SET status = 'resolved',
            resolved_at = NOW(),
            updated_at = NOW()
        WHERE dedupe_key = ANY($1::text[])
          AND status = 'open'
      `,
      [dedupeKeys],
    );
  }

  private async syncReservationCoverageAlerts(
    client: PoolClient,
    apartmentId: string,
  ): Promise<void> {
    const missingResult = await client.query(
      `
        SELECT reservation.id, reservation.start_date, reservation.end_date
        FROM reservations AS reservation
        WHERE reservation.apartment_id = $1
          AND reservation.origin = 'booking_email'
          AND reservation.status <> 'cancelled'
          AND reservation.end_date >= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1
            FROM ical_availability_observations AS observation
            WHERE observation.apartment_id = reservation.apartment_id
              AND observation.source_system = 'booking_ical'
              AND observation.is_current = true
              AND observation.start_date <= reservation.start_date
              AND observation.end_date >= reservation.end_date
          )
      `,
      [apartmentId],
    );

    const missingKeys: string[] = [];
    for (const row of missingResult.rows) {
      const startDate = this.formatDateLocal(row.start_date);
      const endDate = this.formatDateLocal(row.end_date);
      const dedupeKey = `reservation_missing_in_ical:${row.id}`;
      missingKeys.push(dedupeKey);
      await this.upsertReviewItem(client, {
        dedupeKey,
        apartmentId,
        reservationId: row.id,
        kind: 'reservation_missing_in_ical',
        severity: 'warning',
        title: 'Rezerwacja Booking z maila nie jest widoczna w iCal',
        details: { startDate, endDate },
      });
    }

    await client.query(
      `
        UPDATE reservation_review_items
        SET status = 'resolved',
            resolved_at = NOW(),
            updated_at = NOW()
        WHERE apartment_id = $1
          AND kind = 'reservation_missing_in_ical'
          AND status = 'open'
          AND NOT (dedupe_key = ANY($2::text[]))
      `,
      [apartmentId, missingKeys],
    );
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
