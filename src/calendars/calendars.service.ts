import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  BookingDto,
  CalendarsResponseDto,
  CreateBookingDto,
  DeleteExternalBookingNoteDto,
  PublicBookingDto,
  PublicCalendarsResponseDto,
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
    const { gory, rynek } = await this.findCalendarApartments();
    const [goryCalendar, rynekCalendar] = await Promise.all([
      this.getApartmentCalendar(gory, (reservation) => this.mapBooking(reservation, false)),
      this.getApartmentCalendar(rynek, (reservation) => this.mapBooking(reservation, false)),
    ]);

    return { gory: goryCalendar, rynek: rynekCalendar };
  }

  async getPublicCalendars(): Promise<PublicCalendarsResponseDto> {
    const { gory, rynek } = await this.findCalendarApartments();
    const [goryCalendar, rynekCalendar] = await Promise.all([
      this.getApartmentCalendar(gory, (reservation) => this.mapPublicBooking(reservation)),
      this.getApartmentCalendar(rynek, (reservation) => this.mapPublicBooking(reservation)),
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

  private async findCalendarApartments() {
    const apartmentsResult = await this.pool.query(`
      SELECT id, name
      FROM apartments
      ORDER BY name
    `);

    const apartments = apartmentsResult.rows;
    return {
      gory: apartments.find((apartment) => apartment.name.toLowerCase().includes('góry')),
      rynek: apartments.find((apartment) => apartment.name.toLowerCase().includes('rynek')),
    };
  }

  private async getApartmentCalendar<T>(
    apartment: any,
    mapBooking: (reservation: ReservationDto) => T,
  ): Promise<{ apartmentId: string; apartmentName: string; bookings: T[] }> {
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
      bookings: reservations.map(mapBooking),
    };
  }

  // Cleaning crew needs headcounts for bedding, but never guest identity or contact data.
  private mapPublicBooking(reservation: ReservationDto): PublicBookingDto {
    return {
      id: reservation.id,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      guestCount: reservation.guestCount,
      adults: reservation.adults,
      children: reservation.children,
      childAges: reservation.childAges,
      infants: reservation.infants,
      pets: reservation.pets,
      note: reservation.note,
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
