import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  ApartmentCalendarDto,
  BookingDto,
  CalendarsResponseDto,
  CreateBookingDto,
  DeleteExternalBookingNoteDto,
  UpdateBookingDto,
  UpsertExternalBookingNoteDto,
} from './calendars.types';
import { ReservationsService } from '../reservations/reservations.service';
import { ReservationActor, ReservationDto } from '../reservations/reservations.types';

@Injectable()
export class CalendarsService {
  constructor(
    @Inject('PG_POOL') private readonly pool: Pool,
    private readonly reservationsService: ReservationsService,
  ) {}

  async getAllCalendars(): Promise<CalendarsResponseDto> {
    const apartmentsResult = await this.pool.query(`
      SELECT id, name
      FROM apartments
      ORDER BY name
    `);

    const apartments = apartmentsResult.rows;
    const goryApartment = apartments.find((apartment) =>
      apartment.name.toLowerCase().includes('góry'),
    );
    const rynekApartment = apartments.find((apartment) =>
      apartment.name.toLowerCase().includes('rynek'),
    );

    const [goryCalendar, rynekCalendar] = await Promise.all([
      this.getApartmentCalendar(goryApartment),
      this.getApartmentCalendar(rynekApartment),
    ]);

    return { gory: goryCalendar, rynek: rynekCalendar };
  }

  async createManualBooking(
    dto: CreateBookingDto,
    actor: ReservationActor,
  ): Promise<BookingDto> {
    const reservation = await this.reservationsService.createManual(dto, actor);
    return this.mapBooking(reservation, true);
  }

  async updateManualBooking(
    id: string,
    dto: UpdateBookingDto,
    actor: ReservationActor,
  ): Promise<BookingDto> {
    const reservation = await this.reservationsService.update(id, dto, actor);
    return this.mapBooking(reservation, true);
  }

  async deleteManualBooking(id: string, actor: ReservationActor): Promise<void> {
    await this.reservationsService.cancelManual(id, actor);
  }

  async upsertExternalBookingNote(
    dto: UpsertExternalBookingNoteDto,
    actor: ReservationActor,
  ): Promise<void> {
    await this.reservationsService.upsertNoteByExternalId({
      apartmentId: dto.apartmentId,
      externalId: dto.externalId,
      note: dto.note,
      createdBy: actor.email,
    });
  }

  async deleteExternalBookingNote(dto: DeleteExternalBookingNoteDto): Promise<void> {
    await this.reservationsService.deleteNoteByExternalId(dto.apartmentId, dto.externalId);
  }

  private async getApartmentCalendar(apartment: any): Promise<ApartmentCalendarDto> {
    if (!apartment) {
      return { apartmentId: '', apartmentName: 'Nieznany', bookings: [] };
    }

    const reservations = await this.reservationsService.list({
      apartmentId: apartment.id,
      includeCancelled: false,
    });

    return {
      apartmentId: apartment.id,
      apartmentName: apartment.name,
      bookings: reservations.map((reservation) => this.mapBooking(reservation, false)),
    };
  }

  private mapBooking(reservation: ReservationDto, includePrivateDetails: boolean): BookingDto {
    return {
      id: reservation.id,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      source: reservation.origin === 'manual' ? 'manual' : 'external',
      origin: reservation.origin,
      status: reservation.status,
      externalId: reservation.externalId,
      ...(includePrivateDetails
        ? {
            guestName: reservation.guestName,
            guestCount: reservation.guestCount,
            adults: reservation.adults,
            children: reservation.children,
          }
        : {}),
      note: reservation.note,
      version: reservation.version,
    };
  }
}
