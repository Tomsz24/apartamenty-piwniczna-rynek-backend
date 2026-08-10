import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import {
  CreateReservationDto,
  ListOrphanedNotesQueryDto,
  ListReservationsQueryDto,
  UpdateReservationDto,
} from './reservations.dto';
import {
  OrphanedReservationNoteDto,
  ReservationActor,
  ReservationDto,
  ReservationOrigin,
  ReservationStatus,
} from './reservations.types';
import { validateDateRange } from './reservations.domain';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

@Injectable()
export class ReservationsService {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async list(query: ListReservationsQueryDto): Promise<ReservationDto[]> {
    if (query.from && query.to) this.assertValidDateRange(query.from, query.to);

    const conditions: string[] = [];
    const values: unknown[] = [];

    const addCondition = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };

    if (query.apartmentId) addCondition('r.apartment_id = ?', query.apartmentId);
    if (query.from) addCondition('r.end_date > ?', query.from);
    if (query.to) addCondition('r.start_date < ?', query.to);
    if (query.status) addCondition('r.status = ?', query.status);
    if (!query.includeCancelled && !query.status) conditions.push(`r.status <> 'cancelled'`);

    const result = await this.pool.query(
      `
        SELECT
          r.*,
          a.name AS apartment_name,
          source_ref.external_id
        FROM reservations AS r
        JOIN apartments AS a ON a.id = r.apartment_id
        LEFT JOIN LATERAL (
          SELECT refs.external_id
          FROM reservation_source_refs AS refs
          WHERE refs.reservation_id = r.id
          ORDER BY refs.is_current DESC,
                   CASE refs.source_system WHEN 'booking_email' THEN 0 ELSE 1 END,
                   refs.last_seen_at DESC
          LIMIT 1
        ) AS source_ref ON true
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY r.start_date, r.end_date, r.created_at
      `,
      values,
    );

    return result.rows.map((row) => this.mapReservation(row));
  }

  async getById(id: string, queryable: Queryable = this.pool): Promise<ReservationDto> {
    const result = await queryable.query(
      `
        SELECT
          r.*,
          a.name AS apartment_name,
          source_ref.external_id
        FROM reservations AS r
        JOIN apartments AS a ON a.id = r.apartment_id
        LEFT JOIN LATERAL (
          SELECT refs.external_id
          FROM reservation_source_refs AS refs
          WHERE refs.reservation_id = r.id
          ORDER BY refs.is_current DESC,
                   CASE refs.source_system WHEN 'booking_email' THEN 0 ELSE 1 END,
                   refs.last_seen_at DESC
          LIMIT 1
        ) AS source_ref ON true
        WHERE r.id = $1
      `,
      [id],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('Rezerwacja nie została znaleziona');
    }

    return this.mapReservation(result.rows[0]);
  }

  async createManual(
    dto: CreateReservationDto,
    actor: ReservationActor | string,
  ): Promise<ReservationDto> {
    this.assertValidDateRange(dto.startDate, dto.endDate);
    this.assertGuestCounts(dto);

    if (dto.status === 'cancelled' || dto.status === 'needs_review') {
      throw new BadRequestException('Nowa ręczna rezerwacja musi być aktywna');
    }

    const createdBy = this.actorName(actor);

    return this.withTransaction(async (client) => {
      await this.lockApartment(client, dto.apartmentId);
      await this.assertApartmentExists(client, dto.apartmentId);
      await this.assertNoOverlap(client, {
        apartmentId: dto.apartmentId,
        startDate: dto.startDate,
        endDate: dto.endDate,
      });

      const guestCount = this.resolveGuestCount(dto);
      const result = await client.query(
        `
          INSERT INTO reservations (
            apartment_id,
            origin,
            status,
            start_date,
            end_date,
            guest_name,
            guest_count,
            adults,
            children,
            note,
            created_by
          )
          VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `,
        [
          dto.apartmentId,
          dto.status ?? 'confirmed',
          dto.startDate,
          dto.endDate,
          this.nullIfEmpty(dto.guestName),
          guestCount,
          dto.adults ?? null,
          dto.children ?? null,
          this.nullIfEmpty(dto.note),
          createdBy,
        ],
      );

      return this.getById(result.rows[0].id, client);
    });
  }

  async update(
    id: string,
    dto: UpdateReservationDto,
    actor: ReservationActor | string,
  ): Promise<ReservationDto> {
    const changeKeys = Object.keys(dto).filter(
      (key) => key !== 'expectedVersion' && dto[key as keyof UpdateReservationDto] !== undefined,
    );
    if (changeKeys.length === 0) {
      throw new BadRequestException('Nie przekazano żadnych zmian');
    }

    return this.withTransaction(async (client) => {
      const existingResult = await client.query(
        `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existingResult.rows.length === 0) {
        throw new NotFoundException('Rezerwacja nie została znaleziona');
      }

      const existing = existingResult.rows[0];
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== existing.version) {
        throw new ConflictException(
          'Rezerwacja została w międzyczasie zmieniona. Odśwież dane i spróbuj ponownie.',
        );
      }

      const scheduleChanged =
        dto.apartmentId !== undefined ||
        dto.startDate !== undefined ||
        dto.endDate !== undefined ||
        dto.status !== undefined;

      if (existing.origin !== 'manual' && scheduleChanged) {
        throw new ConflictException(
          'Daty i status rezerwacji Booking są aktualizowane przez synchronizację. Ręcznie można zmienić dane gości i notatkę.',
        );
      }

      const apartmentId = dto.apartmentId ?? existing.apartment_id;
      const startDate = dto.startDate ?? this.formatDate(existing.start_date);
      const endDate = dto.endDate ?? this.formatDate(existing.end_date);
      const status = (dto.status ?? existing.status) as ReservationStatus;

      this.assertValidDateRange(startDate, endDate);
      this.assertGuestCounts({
        guestCount: dto.guestCount === undefined ? existing.guest_count : dto.guestCount,
        adults: dto.adults === undefined ? existing.adults : dto.adults,
        children: dto.children === undefined ? existing.children : dto.children,
      });

      await this.lockApartment(client, apartmentId);
      await this.assertApartmentExists(client, apartmentId);

      if (status !== 'cancelled') {
        await this.assertNoOverlap(client, {
          apartmentId,
          startDate,
          endDate,
          excludeReservationId: id,
        });
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      const setValue = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };

      if (dto.apartmentId !== undefined) setValue('apartment_id', dto.apartmentId);
      if (dto.startDate !== undefined) setValue('start_date', dto.startDate);
      if (dto.endDate !== undefined) setValue('end_date', dto.endDate);
      if (dto.status !== undefined) {
        setValue('status', dto.status);
        updates.push(dto.status === 'cancelled' ? 'cancelled_at = NOW()' : 'cancelled_at = NULL');
      }
      if (dto.guestName !== undefined) setValue('guest_name', this.nullIfEmpty(dto.guestName));
      if (dto.guestCount !== undefined) setValue('guest_count', dto.guestCount);
      if (dto.adults !== undefined) setValue('adults', dto.adults);
      if (dto.children !== undefined) setValue('children', dto.children);
      if (dto.note !== undefined) setValue('note', this.nullIfEmpty(dto.note));

      updates.push('updated_at = NOW()', 'version = version + 1');
      values.push(id);

      await client.query(
        `UPDATE reservations SET ${updates.join(', ')} WHERE id = $${values.length}`,
        values,
      );

      return this.getById(id, client);
    });
  }

  async cancelManual(id: string, actor: ReservationActor | string): Promise<ReservationDto> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT origin, status FROM reservations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (result.rows.length === 0) {
        throw new NotFoundException('Rezerwacja nie została znaleziona');
      }
      if (result.rows[0].origin !== 'manual') {
        throw new ConflictException(
          'Rezerwacji Booking nie można usunąć ręcznie. Jej anulowanie musi przyjść ze źródła.',
        );
      }

      if (result.rows[0].status !== 'cancelled') {
        await client.query(
          `
            UPDATE reservations
            SET status = 'cancelled',
                cancelled_at = NOW(),
                updated_at = NOW(),
                version = version + 1,
                metadata = metadata || jsonb_build_object('cancelledBy', $2::text)
            WHERE id = $1
          `,
          [id, this.actorName(actor)],
        );
      }

      return this.getById(id, client);
    });
  }

  async listOrphanedNotes(
    query: ListOrphanedNotesQueryDto,
  ): Promise<OrphanedReservationNoteDto[]> {
    const result = await this.pool.query(
      `
        SELECT notes.*, apartments.name AS apartment_name
        FROM orphaned_reservation_notes AS notes
        JOIN apartments ON apartments.id = notes.apartment_id
        WHERE notes.attached_to_reservation_id IS NULL
          AND ($1::uuid IS NULL OR notes.apartment_id = $1::uuid)
        ORDER BY notes.updated_at DESC
      `,
      [query.apartmentId ?? null],
    );

    return result.rows.map((row) => ({
      id: row.id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name,
      sourceSystem: row.source_system,
      externalId: row.external_id,
      note: row.note,
      createdBy: row.created_by,
      createdAt: this.formatTimestamp(row.created_at),
      updatedAt: this.formatTimestamp(row.updated_at),
    }));
  }

  async attachOrphanedNote(
    reservationId: string,
    noteId: string,
    actor: ReservationActor | string,
  ): Promise<ReservationDto> {
    return this.withTransaction(async (client) => {
      const reservationResult = await client.query(
        `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
        [reservationId],
      );
      const noteResult = await client.query(
        `SELECT * FROM orphaned_reservation_notes WHERE id = $1 FOR UPDATE`,
        [noteId],
      );

      if (reservationResult.rows.length === 0) {
        throw new NotFoundException('Rezerwacja nie została znaleziona');
      }
      if (noteResult.rows.length === 0 || noteResult.rows[0].attached_to_reservation_id) {
        throw new NotFoundException('Osierocona notatka nie została znaleziona');
      }

      const reservation = reservationResult.rows[0];
      const orphan = noteResult.rows[0];
      if (reservation.apartment_id !== orphan.apartment_id) {
        throw new ConflictException('Notatka i rezerwacja dotyczą różnych apartamentów');
      }

      const currentNote = (reservation.note as string | null)?.trim();
      const orphanNote = (orphan.note as string).trim();
      const mergedNote = currentNote
        ? currentNote.includes(orphanNote)
          ? currentNote
          : `${currentNote}\n${orphanNote}`
        : orphanNote;

      await client.query(
        `
          UPDATE reservations
          SET note = $2,
              updated_at = NOW(),
              version = version + 1
          WHERE id = $1
        `,
        [reservationId, mergedNote],
      );
      await client.query(
        `
          UPDATE orphaned_reservation_notes
          SET attached_to_reservation_id = $2,
              attached_at = NOW(),
              updated_at = NOW(),
              created_by = created_by || ' / attached:' || $3::text
          WHERE id = $1
        `,
        [noteId, reservationId, this.actorName(actor)],
      );

      return this.getById(reservationId, client);
    });
  }

  async upsertNoteByExternalId(params: {
    apartmentId: string;
    externalId: string;
    note: string;
    createdBy: string;
  }): Promise<void> {
    const ref = await this.pool.query(
      `
        SELECT reservation_id
        FROM reservation_source_refs
        WHERE apartment_id = $1
          AND external_id = $2
        ORDER BY is_current DESC, last_seen_at DESC
        LIMIT 1
      `,
      [params.apartmentId, params.externalId],
    );

    if (ref.rows.length > 0) {
      await this.pool.query(
        `
          UPDATE reservations
          SET note = $2, updated_at = NOW(), version = version + 1
          WHERE id = $1
        `,
        [ref.rows[0].reservation_id, this.nullIfEmpty(params.note)],
      );
      return;
    }

    await this.pool.query(
      `
        INSERT INTO orphaned_reservation_notes (
          apartment_id, source_system, external_id, note, created_by
        )
        VALUES ($1, 'booking_ical', $2, $3, $4)
        ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
          note = EXCLUDED.note,
          created_by = EXCLUDED.created_by,
          updated_at = NOW(),
          attached_to_reservation_id = NULL,
          attached_at = NULL
      `,
      [params.apartmentId, params.externalId, params.note, params.createdBy],
    );
  }

  async deleteNoteByExternalId(apartmentId: string, externalId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `
          UPDATE reservations
          SET note = NULL, updated_at = NOW(), version = version + 1
          WHERE id IN (
            SELECT reservation_id
            FROM reservation_source_refs
            WHERE apartment_id = $1 AND external_id = $2
          )
        `,
        [apartmentId, externalId],
      );
      await client.query(
        `
          DELETE FROM orphaned_reservation_notes
          WHERE apartment_id = $1 AND external_id = $2
        `,
        [apartmentId, externalId],
      );
    });
  }

  private async assertNoOverlap(
    client: PoolClient,
    params: {
      apartmentId: string;
      startDate: string;
      endDate: string;
      excludeReservationId?: string;
    },
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT id
        FROM reservations
        WHERE apartment_id = $1
          AND status <> 'cancelled'
          AND start_date < $3
          AND end_date > $2
          AND ($4::uuid IS NULL OR id <> $4::uuid)
        LIMIT 1
      `,
      [
        params.apartmentId,
        params.startDate,
        params.endDate,
        params.excludeReservationId ?? null,
      ],
    );

    if (result.rows.length > 0) {
      throw new ConflictException('Termin nachodzi na istniejącą rezerwację');
    }
  }

  private async assertApartmentExists(client: PoolClient, apartmentId: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM apartments WHERE id = $1`, [apartmentId]);
    if (result.rows.length === 0) {
      throw new BadRequestException('Wybrany apartament nie istnieje');
    }
  }

  private async lockApartment(client: PoolClient, apartmentId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [apartmentId]);
  }

  private assertValidDateRange(startDate: string, endDate: string): void {
    const error = validateDateRange(startDate, endDate);
    if (error) throw new BadRequestException(error);
  }

  private assertGuestCounts(values: {
    guestCount?: number | null;
    adults?: number | null;
    children?: number | null;
  }): void {
    const adults = values.adults ?? null;
    const children = values.children ?? null;
    const guestCount = values.guestCount ?? null;

    if (adults !== null && children !== null && guestCount !== null) {
      if (adults + children !== guestCount) {
        throw new BadRequestException(
          'Łączna liczba gości musi być sumą liczby dorosłych i dzieci',
        );
      }
    }

    if (adults !== null && children !== null && adults + children < 1) {
      throw new BadRequestException('Rezerwacja musi obejmować przynajmniej jednego gościa');
    }
  }

  private resolveGuestCount(values: {
    guestCount?: number | null;
    adults?: number | null;
    children?: number | null;
  }): number | null {
    if (values.guestCount !== undefined && values.guestCount !== null) {
      return values.guestCount;
    }
    if (values.adults !== undefined && values.children !== undefined) {
      return (values.adults ?? 0) + (values.children ?? 0);
    }
    return null;
  }

  private mapReservation(row: any): ReservationDto {
    return {
      id: row.id,
      apartmentId: row.apartment_id,
      apartmentName: row.apartment_name ?? undefined,
      origin: row.origin as ReservationOrigin,
      status: row.status as ReservationStatus,
      startDate: this.formatDate(row.start_date),
      endDate: this.formatDate(row.end_date),
      guestName: row.guest_name ?? null,
      guestCount: row.guest_count ?? null,
      adults: row.adults ?? null,
      children: row.children ?? null,
      note: row.note ?? null,
      externalId: row.external_id ?? undefined,
      createdBy: row.created_by,
      createdAt: this.formatTimestamp(row.created_at),
      updatedAt: this.formatTimestamp(row.updated_at),
      version: row.version,
    };
  }

  private actorName(actor: ReservationActor | string): string {
    return typeof actor === 'string' ? actor : actor.email || actor.id;
  }

  private nullIfEmpty(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private formatDate(value: Date | string): string {
    if (typeof value === 'string') return value.split('T')[0];
    return value.toISOString().slice(0, 10);
  }

  private formatTimestamp(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
