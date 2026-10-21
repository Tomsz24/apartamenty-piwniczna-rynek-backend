import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsArray,
  IsDateString,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
} from 'class-validator';
import { RESERVATION_STATUSES, ReservationStatus } from './reservations.types';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateReservationDto {
  @IsUUID()
  apartmentId: string;

  // Stable across retries so Hostex's channel_id idempotency prevents duplicates.
  @IsOptional()
  @IsUUID()
  clientReservationId?: string;

  @IsDateString({ strict: true })
  startDate: string;

  @IsDateString({ strict: true })
  endDate: string;

  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  guestName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  guestCount?: number;

  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  adults: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  children?: number;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(4000)
  note?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(40)
  guestPhone?: string;

  @IsOptional()
  @Transform(trimString)
  @IsEmail()
  @MaxLength(254)
  guestEmail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childAges?: number[];

  @IsDefined()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalRateAmount: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountReceived?: number;
}

export class UpdateReservationDto {
  @IsOptional()
  @IsUUID()
  apartmentId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  guestName?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  guestCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  adults?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  children?: number | null;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(4000)
  note?: string | null;

  @IsOptional()
  @IsDateString()
  arrivalMessageSentAt?: string | null;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(40)
  guestPhone?: string | null;

  @IsOptional()
  @Transform(trimString)
  @IsEmail()
  @MaxLength(254)
  guestEmail?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childAges?: number[] | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListReservationsQueryDto {
  @IsOptional()
  @IsUUID()
  apartmentId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeCancelled?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeLegacy?: boolean;
}

export class ListOrphanedNotesQueryDto {
  @IsOptional()
  @IsUUID()
  apartmentId?: string;
}
