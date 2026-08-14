import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CreateReservationDto, UpdateReservationDto } from '../reservations/reservations.dto';
import { ReservationOrigin, ReservationStatus } from '../reservations/reservations.types';

export interface BookingDto {
  id: string;
  startDate: string;
  endDate: string;
  source: 'manual' | 'external';
  origin: ReservationOrigin;
  status: ReservationStatus;
  externalId?: string;
  guestName?: string | null;
  guestCount?: number | null;
  adults?: number | null;
  children?: number | null;
  note?: string | null;
  version: number;
}

export interface ApartmentCalendarDto {
  apartmentId: string;
  apartmentName: string;
  bookings: BookingDto[];
}

export interface CalendarsResponseDto {
  gory: ApartmentCalendarDto;
  rynek: ApartmentCalendarDto;
}

export class CreateBookingDto extends CreateReservationDto {
  @IsOptional()
  @IsString()
  createdBy?: string;
}

export class UpdateBookingDto extends UpdateReservationDto {}

export class UpsertExternalBookingNoteDto {
  @IsUUID()
  apartmentId: string;

  @IsString()
  @MaxLength(500)
  externalId: string;

  @IsString()
  @MaxLength(4000)
  note: string;

  @IsOptional()
  @IsString()
  createdBy?: string;
}

export class DeleteExternalBookingNoteDto {
  @IsUUID()
  apartmentId: string;

  @IsString()
  @MaxLength(500)
  externalId: string;
}
