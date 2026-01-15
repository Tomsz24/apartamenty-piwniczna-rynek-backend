import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  ApartmentCalendarDto,
  BookingDto,
  CalendarsResponseDto,
  CreateBookingDto,
  UpdateBookingDto,
} from './calendars.types';

@Injectable()
export class CalendarsService {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async getAllCalendars(): Promise<CalendarsResponseDto> {
    const apartmentsResult = await this.pool.query(`
        SELECT id, name, description
        FROM apartments
        ORDER BY name
    `);

    const apartments = apartmentsResult.rows;

    const goryApartment = apartments.find((a) => a.name.toLowerCase().includes('góry'));
    const rynekApartment = apartments.find((a) => a.name.toLowerCase().includes('rynek'));

    const [goryCalendar, rynekCalendar] = await Promise.all([
      this.getApartmentCalendar(goryApartment),
      this.getApartmentCalendar(rynekApartment),
    ]);

    return { gory: goryCalendar, rynek: rynekCalendar };
  }

  async createManualBooking(dto: CreateBookingDto): Promise<BookingDto> {
    await this.assertNoOverlaps({
      apartmentId: dto.apartmentId,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });

    const result = await this.pool.query(
      `
          INSERT INTO bookings_manual (apartment_id, start_date, end_date, note, created_by)
          VALUES ($1, $2, $3, $4, $5)
              RETURNING id, start_date, end_date, note
      `,
      [dto.apartmentId, dto.startDate, dto.endDate, dto.note || null, dto.createdBy || 'admin'],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      startDate: this.formatDate(row.start_date),
      endDate: this.formatDate(row.end_date),
      source: 'manual',
      note: row.note,
    };
  }

  async updateManualBooking(id: string, dto: UpdateBookingDto): Promise<BookingDto> {
    const existing = await this.pool.query(
      `
          SELECT apartment_id, start_date, end_date
          FROM bookings_manual
          WHERE id = $1
      `,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const apartmentId = existing.rows[0].apartment_id as string;
    const currentStart = this.formatDate(existing.rows[0].start_date);
    const currentEnd = this.formatDate(existing.rows[0].end_date);

    const nextStart = dto.startDate ?? currentStart;
    const nextEnd = dto.endDate ?? currentEnd;

    await this.assertNoOverlaps({
      apartmentId,
      startDate: nextStart,
      endDate: nextEnd,
      excludeManualBookingId: id,
    });

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (dto.startDate) {
      updates.push(`start_date = $${paramIndex++}`);
      values.push(dto.startDate);
    }

    if (dto.endDate) {
      updates.push(`end_date = $${paramIndex++}`);
      values.push(dto.endDate);
    }

    if (dto.note !== undefined) {
      updates.push(`note = $${paramIndex++}`);
      values.push(dto.note);
    }

    updates.push('updated_at = NOW()');

    values.push(id);

    const result = await this.pool.query(
      `
          UPDATE bookings_manual
          SET ${updates.join(', ')}
          WHERE id = $${paramIndex}
              RETURNING id, start_date, end_date, note
      `,
      values,
    );

    if (result.rows.length === 0) {
      throw new Error('Booking not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      startDate: this.formatDate(row.start_date),
      endDate: this.formatDate(row.end_date),
      source: 'manual',
      note: row.note,
    };
  }

  async deleteManualBooking(id: string): Promise<void> {
    await this.pool.query('DELETE FROM bookings_manual WHERE id = $1', [id]);
  }

  private async getApartmentCalendar(apartment: any): Promise<ApartmentCalendarDto> {
    if (!apartment) {
      return { apartmentId: '', apartmentName: 'Nieznany', bookings: [] };
    }

    const manualResult = await this.pool.query(
      `
          SELECT id, start_date, end_date, note
          FROM bookings_manual
          WHERE apartment_id = $1
          ORDER BY start_date
      `,
      [apartment.id],
    );

    const externalResult = await this.pool.query(
      `
          SELECT id, start_date, end_date
          FROM bookings_external
          WHERE apartment_id = $1
          ORDER BY start_date
      `,
      [apartment.id],
    );

    const manualBookings: BookingDto[] = manualResult.rows.map((row) => ({
      id: row.id,
      startDate: this.formatDate(row.start_date),
      endDate: this.formatDate(row.end_date),
      source: 'manual',
      note: row.note,
    }));

    const externalBookings: BookingDto[] = externalResult.rows.map((row) => ({
      id: row.id,
      startDate: this.formatDate(row.start_date),
      endDate: this.formatDate(row.end_date),
      source: 'external',
    }));

    const allBookings = [...manualBookings, ...externalBookings].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );

    return { apartmentId: apartment.id, apartmentName: apartment.name, bookings: allBookings };
  }

  private async assertNoOverlaps(params: {
    apartmentId: string;
    startDate: string;
    endDate: string;
    excludeManualBookingId?: string;
  }): Promise<void> {
    const { apartmentId, startDate, endDate, excludeManualBookingId } = params;

    const manualConflict = await this.pool.query(
      `
          SELECT 1
          FROM bookings_manual
          WHERE apartment_id = $1
            AND start_date < $3
            AND end_date > $2
            AND ($4::uuid IS NULL OR id <> $4::uuid)
              LIMIT 1
      `,
      [apartmentId, startDate, endDate, excludeManualBookingId ?? null],
    );

    if (manualConflict.rows.length > 0) {
      throw new ConflictException('Termin nachodzi na istniejącą rezerwację manualną');
    }

    const externalConflict = await this.pool.query(
      `
          SELECT 1
          FROM bookings_external
          WHERE apartment_id = $1
            AND start_date < $3
            AND end_date > $2
              LIMIT 1
      `,
      [apartmentId, startDate, endDate],
    );

    if (externalConflict.rows.length > 0) {
      throw new ConflictException('Termin nachodzi na rezerwację z Booking.com');
    }
  }

  private formatDate(date: Date | string): string {
    if (typeof date === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
      return date.split('T')[0];
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
