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

  /**
   * Automatyczna synchronizacja co 15 minut
   */
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
   * Zapisuje rezerwacje zewnętrzne do bazy
   * Strategia: UPSERT na podstawie external_id (UID z iCal)
   */
  private async saveExternalBookings(
    apartmentId: string,
    events: IcalEvent[],
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const currentUids = events.map((e) => e.uid);

      if (currentUids.length > 0) {
        await client.query(
          `
              DELETE FROM bookings_external
              WHERE apartment_id = $1
                AND external_id NOT IN (SELECT unnest($2::text[]))
          `,
          [apartmentId, currentUids],
        );
      } else {
        await client.query(
          `DELETE FROM bookings_external WHERE apartment_id = $1`,
          [apartmentId],
        );
      }

      for (const event of events) {
        await client.query(
          `
              INSERT INTO bookings_external (apartment_id, external_id, source, start_date, end_date, last_synced_at)
              VALUES ($1, $2, 'booking', $3, $4, NOW())
                  ON CONFLICT (apartment_id, external_id) 
          DO UPDATE SET
                  start_date = EXCLUDED.start_date,
                                   end_date = EXCLUDED.end_date,
                                   last_synced_at = NOW()
          `,
          [
            apartmentId,
            event.uid,
            this.formatDateLocal(event.start),
            this.formatDateLocal(event.end),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Formatuje datę bez konwersji do UTC
   */
  private formatDateLocal(date: Date): string {
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
