import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool, PoolClient } from 'pg';
import { HostexService } from './hostex.service';
import { HostexPropertySummary, HostexReservationSummary } from './hostex.types';

type ReservationStatus = 'confirmed' | 'tentative' | 'cancelled' | 'needs_review';
type SyncAction = 'created' | 'updated' | 'adopted_ical' | 'conflict' | 'unmapped';

type ApartmentMapping = {
  hostexPropertyId: number;
  hostexTitle: string;
  apartmentId: string;
  apartmentName: string;
};

type PlannedReservation = {
  item: HostexReservationSummary;
  mapping: ApartmentMapping | null;
  action: SyncAction;
  reservationId?: string;
  conflictingReservationIds?: string[];
};

@Injectable()
export class HostexSyncService implements OnModuleInit {
  private readonly logger = new Logger(HostexSyncService.name);
  private readonly automaticSyncEnabled: boolean;
  private automaticSyncInProgress = false;
  private lastSyncStartedAt: string | null = null;
  private lastSyncFinishedAt: string | null = null;
  private lastSyncSucceededAt: string | null = null;
  private lastSyncError: string | null = null;
  private lastSyncCounts: Record<SyncAction, number> | null = null;

  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly hostexService: HostexService,
    private readonly configService: ConfigService,
  ) {
    this.automaticSyncEnabled = this.readBoolean(
      this.configService.get<string>('HOSTEX_SYNC_ENABLED'),
      false,
    );
  }

  onModuleInit(): void {
    if (!this.automaticSyncEnabled) {
      this.logger.log('Automatyczna synchronizacja Hostex jest wyłączona');
      return;
    }

    // Do not hold up HTTP startup while Hostex or the database is unavailable.
    void this.runAutomaticSync('start aplikacji');
  }

  @Cron('*/5 * * * *')
  async handleScheduledSync(): Promise<void> {
    if (!this.automaticSyncEnabled) return;
    await this.runAutomaticSync('harmonogram co 5 minut');
  }

  getAutomaticSyncStatus() {
    return {
      enabled: this.automaticSyncEnabled,
      intervalMinutes: 5,
      inProgress: this.automaticSyncInProgress,
      lastStartedAt: this.lastSyncStartedAt,
      lastFinishedAt: this.lastSyncFinishedAt,
      lastSucceededAt: this.lastSyncSucceededAt,
      lastError: this.lastSyncError,
      counts: this.lastSyncCounts,
    };
  }

  private async runAutomaticSync(trigger: string): Promise<void> {
    if (this.automaticSyncInProgress) {
      this.logger.warn(`Pomijam synchronizację Hostex (${trigger}): poprzednia nadal trwa`);
      return;
    }

    this.automaticSyncInProgress = true;
    this.lastSyncStartedAt = new Date().toISOString();
    this.lastSyncError = null;
    this.logger.log(`Rozpoczynam automatyczną synchronizację Hostex (${trigger})`);
    try {
      const result = await this.syncReservations(true);
      this.lastSyncCounts = result.counts;
      this.lastSyncSucceededAt = new Date().toISOString();
      this.logger.log(
        `Synchronizacja Hostex zakończona: pobrano ${result.fetched}, ` +
        `nowe ${result.counts.created}, aktualizacje ${result.counts.updated}, ` +
        `adoptowane ${result.counts.adopted_ical}, konflikty ${result.counts.conflict}, ` +
        `bez mapowania ${result.counts.unmapped}`,
      );
    } catch (error) {
      // Keep a short, sanitized diagnostic; never expose a provider payload or guest data.
      this.lastSyncError = this.safeErrorMessage(error);
      this.logger.error(`Automatyczna synchronizacja Hostex nie powiodła się: ${this.lastSyncError}`);
    } finally {
      this.lastSyncFinishedAt = new Date().toISOString();
      this.automaticSyncInProgress = false;
    }
  }

  private safeErrorMessage(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return 'Nieznany błąd synchronizacji';
    }
    const message = String(error.message);
    return message
      .replace(/(?:Bearer|Hostex-Access-Token)\s+\S+/gi, '[dane uwierzytelniające ukryte]')
      .replace(/https?:\/\/\S+/gi, '[adres ukryty]')
      .slice(0, 240);
  }

  async listMappings(): Promise<{
    apartments: Array<{ id: string; name: string; hostexPropertyId: number | null }>;
    hostexProperties: HostexPropertySummary[];
  }> {
    const [apartments, hostexProperties] = await Promise.all([
      this.pool.query(
        `SELECT apartment.id, apartment.name, mapping.hostex_property_id
         FROM apartments AS apartment
         LEFT JOIN hostex_property_mappings AS mapping ON mapping.apartment_id = apartment.id
         ORDER BY apartment.name`,
      ),
      this.listAllProperties(),
    ]);

    return {
      apartments: apartments.rows.map((row) => ({
        id: row.id,
        name: row.name,
        hostexPropertyId: row.hostex_property_id === null ? null : Number(row.hostex_property_id),
      })),
      hostexProperties,
    };
  }

  async listSyncIssues(): Promise<Array<{
    id: string;
    apartmentId: string | null;
    apartmentName: string | null;
    kind: string;
    title: string;
    details: Record<string, unknown>;
    firstSeenAt: string;
    lastSeenAt: string;
  }>> {
    const result = await this.pool.query(
      `SELECT issue.id, issue.apartment_id, apartment.name AS apartment_name,
              issue.kind, issue.title, issue.details, issue.first_seen_at, issue.last_seen_at
       FROM reservation_review_items AS issue
       LEFT JOIN apartments AS apartment ON apartment.id = issue.apartment_id
       WHERE issue.kind IN ('hostex_reservation_conflict', 'hostex_unknown_status')
         AND issue.status = 'open'
       ORDER BY CASE issue.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                issue.last_seen_at DESC
       LIMIT 100`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
      kind: row.kind,
      title: row.title,
      details: row.details,
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    }));
  }

  async setMapping(hostexPropertyId: number, apartmentId: string): Promise<ApartmentMapping> {
    const [propertyPage, apartmentResult] = await Promise.all([
      this.hostexService.listProperties({ offset: 0, limit: 100, id: hostexPropertyId }),
      this.pool.query(`SELECT id, name FROM apartments WHERE id = $1`, [apartmentId]),
    ]);
    const property = propertyPage.items.find((candidate) => candidate.id === hostexPropertyId);
    if (!property) throw new NotFoundException('Obiekt Hostex nie został znaleziony');
    if (!apartmentResult.rows[0]) throw new NotFoundException('Apartament nie został znaleziony');

    const existing = await this.pool.query(
      `SELECT hostex_property_id FROM hostex_property_mappings
       WHERE apartment_id = $1 AND hostex_property_id <> $2`,
      [apartmentId, hostexPropertyId],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException('Ten apartament ma już przypisany inny obiekt Hostex');
    }

    try {
      await this.pool.query(
        `INSERT INTO hostex_property_mappings (hostex_property_id, apartment_id, hostex_title)
         VALUES ($1, $2, $3)
         ON CONFLICT (hostex_property_id) DO UPDATE SET
           apartment_id = EXCLUDED.apartment_id,
           hostex_title = EXCLUDED.hostex_title,
           updated_at = NOW()`,
        [hostexPropertyId, apartmentId, property.title],
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Ten apartament ma już przypisany inny obiekt Hostex');
      }
      throw error;
    }

    return {
      hostexPropertyId,
      hostexTitle: property.title,
      apartmentId,
      apartmentName: apartmentResult.rows[0].name,
    };
  }

  async syncReservations(apply: boolean, filter: { reservationCode?: string } = {}): Promise<{
    mode: 'preview' | 'applied';
    fetched: number;
    mappedProperties: number;
    counts: Record<SyncAction, number>;
    items: Array<{
      propertyId: number;
      stayCode: string;
      reservationCode: string;
      apartmentId: string | null;
      apartmentName: string | null;
      status: string;
      action: SyncAction;
    }>;
  }> {
    const [mappings, reservations] = await Promise.all([
      this.getApartmentMappings(),
      this.listAllReservations(filter.reservationCode),
    ]);
    const plans: PlannedReservation[] = [];
    const seen = new Set<string>();

    for (const item of reservations) {
      const dedupe = `${item.propertyId}:${item.stayCode}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const mapping = mappings.get(item.propertyId) ?? null;
      plans.push({
        item,
        mapping,
        ...(mapping
          ? await this.planReservation(this.pool, item, mapping)
          : { action: 'unmapped' as const }),
      });
    }

    if (apply) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('hostex-reservation-sync'))`);
        for (const plan of plans) {
          if (!plan.mapping) continue;
          const current = await this.planReservation(client, plan.item, plan.mapping);
          plan.action = current.action;
          plan.reservationId = current.reservationId;
          plan.conflictingReservationIds = current.conflictingReservationIds;
          if (current.action === 'conflict') {
            await this.recordConflict(client, plan);
            continue;
          }
          const reservationId = await this.upsertReservation(client, plan, current);
          plan.reservationId = reservationId;
          if (this.toReservationStatus(plan.item.status) === 'needs_review') {
            await this.recordUnknownStatus(client, plan, reservationId);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    const counts: Record<SyncAction, number> = {
      created: 0,
      updated: 0,
      adopted_ical: 0,
      conflict: 0,
      unmapped: 0,
    };
    for (const plan of plans) counts[plan.action] += 1;

    return {
      mode: apply ? 'applied' : 'preview',
      fetched: plans.length,
      mappedProperties: mappings.size,
      counts,
      items: plans.map((plan) => ({
        propertyId: plan.item.propertyId,
        stayCode: plan.item.stayCode,
        reservationCode: plan.item.reservationCode,
        apartmentId: plan.mapping?.apartmentId ?? null,
        apartmentName: plan.mapping?.apartmentName ?? null,
        status: plan.item.status,
        action: plan.action,
      })),
    };
  }

  async syncReservationByChannelId(channelId: string): Promise<{
    reservationId: string;
    action: SyncAction;
  }> {
    const page = await this.hostexService.listReservations({ offset: 0, limit: 100, channelId });
    const items = page.items.filter((item) => item.channelId === channelId);
    if (items.length !== 1) {
      throw new NotFoundException(
        items.length === 0
          ? 'Hostex nie zwrócił utworzonej rezerwacji. Ponów zapis z tym samym identyfikatorem.'
          : 'Hostex zwrócił wiele pobytów dla identyfikatora tej rezerwacji; wymagane jest ręczne sprawdzenie.',
      );
    }

    const item = items[0];
    if (this.toReservationStatus(item.status) === 'cancelled') {
      throw new ConflictException(
        'Hostex zwrócił anulowaną rezerwację dla tego identyfikatora. Użyj nowego szkicu rezerwacji zamiast ponawiać anulowany zapis.',
      );
    }
    const mappings = await this.getApartmentMappings();
    const mapping = mappings.get(item.propertyId);
    if (!mapping) throw new BadRequestException('Brak mapowania obiektu Hostex do apartamentu');

    const client = await this.pool.connect();
    let conflict = false;
    let importedReservationId: string | null = null;
    let action: SyncAction = 'created';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('hostex-reservation-sync'))`);
      const current = await this.planReservation(client, item, mapping);
      if (current.action === 'conflict') {
        const plan: PlannedReservation = {
          item,
          mapping,
          action: current.action,
          reservationId: current.reservationId,
          conflictingReservationIds: current.conflictingReservationIds,
        };
        await this.recordConflict(client, plan);
        conflict = true;
      } else {
        const plan: PlannedReservation = { item, mapping, action: current.action };
        importedReservationId = await this.upsertReservation(client, plan, current);
        action = current.action;
        if (this.toReservationStatus(item.status) === 'needs_review') {
          await this.recordUnknownStatus(client, plan, importedReservationId);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (conflict) {
      throw new ConflictException(
        'Hostex utworzył rezerwację, ale lokalny kalendarz wykrył nakładający się wpis. Sprawdź kolejkę konfliktów.',
      );
    }
    return { reservationId: importedReservationId!, action };
  }

  async getLinkedReservation(reservationId: string): Promise<{
    stayCode: string;
    reservationCode: string | null;
    channelId: string | null;
    channelType: string | null;
  }> {
    const result = await this.pool.query(
      `SELECT source_ref.external_id AS stay_code, source_ref.raw_data,
              reservation.metadata
       FROM reservation_source_refs AS source_ref
       JOIN reservations AS reservation ON reservation.id = source_ref.reservation_id
       WHERE source_ref.reservation_id = $1
         AND source_ref.source_system = 'hostex'
         AND source_ref.is_current = true
       ORDER BY source_ref.last_seen_at DESC
       LIMIT 1`,
      [reservationId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Rezerwacja nie ma powiązania z Hostex');
    const rawData = this.asJsonObject(row.raw_data);
    const metadata = this.asJsonObject(row.metadata);
    return {
      stayCode: String(row.stay_code),
      reservationCode: this.optionalString(rawData.reservationCode ?? metadata.reservationCode),
      channelId: this.optionalString(rawData.channelId),
      channelType: this.optionalString(rawData.channelType ?? metadata.channelType),
    };
  }

  private asJsonObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    }
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private async planReservation(
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    item: HostexReservationSummary,
    mapping: ApartmentMapping,
  ): Promise<Pick<PlannedReservation, 'action' | 'reservationId' | 'conflictingReservationIds'>> {
    const source = await queryable.query(
      `SELECT reservation.id
       FROM reservation_source_refs AS source_ref
       JOIN reservations AS reservation ON reservation.id = source_ref.reservation_id
       WHERE source_ref.apartment_id = $1
         AND source_ref.source_system = 'hostex'
         AND source_ref.external_id = $2
       LIMIT 1`,
      [mapping.apartmentId, item.stayCode],
    );
    if (source.rows[0]) {
      return { action: 'updated', reservationId: source.rows[0].id };
    }

    const overlaps = await queryable.query(
      `SELECT id, origin, start_date::text, end_date::text
       FROM reservations
       WHERE apartment_id = $1
         AND status <> 'cancelled'
         AND start_date < $3
         AND end_date > $2
       ORDER BY start_date, id`,
      [mapping.apartmentId, item.checkInDate, item.checkOutDate],
    );
    const exactLegacyMatches = overlaps.rows.filter(
      (row) =>
        row.origin === 'booking_ical' &&
        String(row.start_date).slice(0, 10) === item.checkInDate &&
        String(row.end_date).slice(0, 10) === item.checkOutDate,
    );
    const activeOverlaps = overlaps.rows.filter(
      (row) => row.origin === 'manual' || row.origin === 'hostex',
    );

    // Preserve local notes/extension data only when one legacy iCal row exactly
    // identifies the Hostex stay. Other iCal blocks are stale availability data.
    if (activeOverlaps.length === 0 && exactLegacyMatches.length === 1) {
      return { action: 'adopted_ical', reservationId: exactLegacyMatches[0].id };
    }
    if (activeOverlaps.length === 0 && exactLegacyMatches.length === 0) {
      return { action: 'created' };
    }

    return {
      action: 'conflict',
      conflictingReservationIds: (activeOverlaps.length > 0 ? activeOverlaps : exactLegacyMatches)
        .map((row) => row.id),
    };
  }

  private async upsertReservation(
    client: PoolClient,
    plan: PlannedReservation,
    current: Pick<PlannedReservation, 'action' | 'reservationId'>,
  ): Promise<string> {
    const { item, mapping } = plan;
    if (!mapping) throw new BadRequestException('Brak mapowania obiektu Hostex');
    const status = this.toReservationStatus(item.status);
    const guestCount = (item.numberOfGuests ??
      (item.numberOfAdults === null && item.numberOfChildren === null
        ? null
        : (item.numberOfAdults ?? 0) + (item.numberOfChildren ?? 0))) || null;
    const metadata = JSON.stringify({
      source: 'hostex',
      propertyId: item.propertyId,
      reservationCode: item.reservationCode,
      channelType: item.channelType,
      conversationId: item.conversationId,
      listingId: item.listingId,
      sourceStatus: item.status,
    });
    let reservationId = current.reservationId;

    if (reservationId) {
      const overlap = status === 'cancelled' ? { rows: [] } : await client.query(
        `SELECT id FROM reservations
         WHERE apartment_id = $1
           AND origin IN ('manual', 'hostex')
           AND status <> 'cancelled'
           AND start_date < $3 AND end_date > $2 AND id <> $4
         LIMIT 1`,
        [mapping.apartmentId, item.checkInDate, item.checkOutDate, reservationId],
      );
      if (overlap.rows.length > 0) {
        plan.action = 'conflict';
        plan.conflictingReservationIds = overlap.rows.map((row) => row.id);
        await this.recordConflict(client, plan);
        return reservationId;
      }
      const updated = await client.query(
        `UPDATE reservations SET
           origin = 'hostex', status = $2, start_date = $3, end_date = $4,
           guest_name = $5, guest_count = $6,
           adults = COALESCE($7, adults), children = COALESCE($8, children),
           infants = COALESCE($9, infants), pets = COALESCE($10, pets),
           guest_phone = COALESCE($11::text, guest_phone),
           guest_email = COALESCE($12::text, guest_email),
           total_rate_amount = $13, amount_received = $14,
           currency = $15, payment_status = $16,
           cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE NULL END,
           metadata = metadata || $17::jsonb, last_seen_at = NOW(),
           updated_at = NOW(), version = version + 1
         WHERE id = $1
           AND (
             origin IS DISTINCT FROM 'hostex'
             OR status IS DISTINCT FROM $2
             OR start_date IS DISTINCT FROM $3::date
             OR end_date IS DISTINCT FROM $4::date
             OR guest_name IS DISTINCT FROM $5
             OR guest_count IS DISTINCT FROM $6
             OR ($7::integer IS NOT NULL AND adults IS DISTINCT FROM $7)
             OR ($8::integer IS NOT NULL AND children IS DISTINCT FROM $8)
             OR ($9::integer IS NOT NULL AND infants IS DISTINCT FROM $9)
             OR ($10::integer IS NOT NULL AND pets IS DISTINCT FROM $10)
             OR ($11::text IS NOT NULL AND guest_phone IS DISTINCT FROM $11::text)
             OR ($12::text IS NOT NULL AND guest_email IS DISTINCT FROM $12::text)
             OR total_rate_amount IS DISTINCT FROM $13
             OR amount_received IS DISTINCT FROM $14
             OR currency IS DISTINCT FROM $15
             OR payment_status IS DISTINCT FROM $16
             OR (metadata || $17::jsonb) IS DISTINCT FROM metadata
             OR ($2 = 'cancelled' AND cancelled_at IS NULL)
             OR ($2 <> 'cancelled' AND cancelled_at IS NOT NULL)
           )`,
        [reservationId, status, item.checkInDate, item.checkOutDate,
          item.guestName, guestCount, item.numberOfAdults, item.numberOfChildren,
          item.numberOfInfants, item.numberOfPets, item.guestPhone, item.guestEmail,
          item.totalRateAmount, item.amountReceived, item.currency, item.paymentStatus, metadata],
      );
      if (updated.rowCount === 0) {
        await client.query(`UPDATE reservations SET last_seen_at = NOW() WHERE id = $1`, [reservationId]);
      }
    } else {
      const inserted = await client.query(
        `INSERT INTO reservations (
           apartment_id, origin, status, start_date, end_date, guest_name,
           guest_count, adults, children, infants, pets, guest_phone, guest_email,
           total_rate_amount, amount_received, currency, payment_status,
           created_by, cancelled_at, last_seen_at, metadata
         ) VALUES ($1, 'hostex', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, 'hostex-sync',
                   CASE WHEN $2 = 'cancelled' THEN NOW() ELSE NULL END, NOW(), $17::jsonb)
         RETURNING id`,
        [mapping.apartmentId, status, item.checkInDate, item.checkOutDate,
          item.guestName, guestCount, item.numberOfAdults, item.numberOfChildren,
          item.numberOfInfants, item.numberOfPets, item.guestPhone, item.guestEmail,
          item.totalRateAmount, item.amountReceived, item.currency, item.paymentStatus, metadata],
      );
      reservationId = inserted.rows[0].id;
    }

    await client.query(
      `INSERT INTO reservation_source_refs (
         reservation_id, apartment_id, source_system, external_id, is_current,
         first_seen_at, last_seen_at, missing_since, raw_data
       ) VALUES ($1, $2, 'hostex', $3, true, NOW(), NOW(), NULL, $4::jsonb)
       ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
         reservation_id = EXCLUDED.reservation_id, is_current = true,
         last_seen_at = NOW(), missing_since = NULL, raw_data = EXCLUDED.raw_data`,
      [reservationId, mapping.apartmentId, item.stayCode, JSON.stringify({
        reservationCode: item.reservationCode,
        stayCode: item.stayCode,
        channelId: item.channelId,
        propertyId: item.propertyId,
        channelType: item.channelType,
        listingId: item.listingId,
      })],
    );
    return reservationId!;
  }

  private async recordConflict(client: PoolClient, plan: PlannedReservation): Promise<void> {
    if (!plan.mapping) return;
    const dedupeKey = `hostex_reservation_conflict:${plan.item.propertyId}:${plan.item.stayCode}`;
    await client.query(
      `INSERT INTO reservation_review_items (
         dedupe_key, apartment_id, kind, severity, status, title, details
       ) VALUES ($1, $2, 'hostex_reservation_conflict', 'critical', 'open',
                 'Rezerwacja Hostex koliduje z istniejącym terminem', $3::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         last_seen_at = NOW(), status = 'open', resolved_at = NULL,
         details = EXCLUDED.details, updated_at = NOW()`,
      [dedupeKey, plan.mapping.apartmentId, JSON.stringify({
        propertyId: plan.item.propertyId,
        stayCode: plan.item.stayCode,
        reservationCode: plan.item.reservationCode,
        startDate: plan.item.checkInDate,
        endDate: plan.item.checkOutDate,
        conflictingReservationIds: plan.conflictingReservationIds ?? [],
      })],
    );
  }

  private async recordUnknownStatus(
    client: PoolClient,
    plan: PlannedReservation,
    reservationId: string,
  ): Promise<void> {
    if (!plan.mapping) return;
    await client.query(
      `INSERT INTO reservation_review_items (
         dedupe_key, apartment_id, reservation_id, kind, severity, status, title, details
       ) VALUES ($1, $2, $3, 'hostex_unknown_status', 'warning', 'open',
                 'Nieznany status rezerwacji Hostex', $4::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         reservation_id = EXCLUDED.reservation_id, last_seen_at = NOW(),
         status = 'open', resolved_at = NULL, details = EXCLUDED.details, updated_at = NOW()`,
      [`hostex_unknown_status:${plan.item.propertyId}:${plan.item.stayCode}`,
        plan.mapping.apartmentId, reservationId, JSON.stringify({
          propertyId: plan.item.propertyId,
          stayCode: plan.item.stayCode,
          sourceStatus: plan.item.status,
        })],
    );
  }

  private async getApartmentMappings(): Promise<Map<number, ApartmentMapping>> {
    const result = await this.pool.query(
      `SELECT mapping.hostex_property_id, mapping.hostex_title,
              apartment.id AS apartment_id, apartment.name AS apartment_name
       FROM hostex_property_mappings AS mapping
       JOIN apartments AS apartment ON apartment.id = mapping.apartment_id`,
    );
    return new Map(result.rows.map((row) => [Number(row.hostex_property_id), {
      hostexPropertyId: Number(row.hostex_property_id),
      hostexTitle: row.hostex_title,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
    }]));
  }

  private async listAllProperties(): Promise<HostexPropertySummary[]> {
    const all: HostexPropertySummary[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await this.hostexService.listProperties({ offset, limit: 100 });
      all.push(...page.items);
      if (page.items.length < 100 || (page.total > 0 && all.length >= page.total)) return all;
    }
    throw new BadRequestException('Hostex zwrócił zbyt wiele obiektów do jednego odczytu');
  }

  private async listAllReservations(reservationCode?: string): Promise<HostexReservationSummary[]> {
    const all: HostexReservationSummary[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await this.hostexService.listReservations({
        offset,
        limit: 100,
        orderBy: 'booked_at',
        ...(reservationCode ? { reservationCode } : {}),
      });
      all.push(...page.items);
      if (page.items.length < 100) return all;
    }
    throw new BadRequestException('Hostex zwrócił zbyt wiele rezerwacji do jednego odczytu');
  }

  private toReservationStatus(status: string): ReservationStatus {
    if (status === 'accepted') return 'confirmed';
    if (status === 'wait_accept' || status === 'wait_pay') return 'tentative';
    if (status === 'cancelled' || status === 'denied' || status === 'timeout') return 'cancelled';
    return 'needs_review';
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }

  private readBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
}
