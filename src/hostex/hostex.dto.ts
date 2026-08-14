import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  HOSTEX_CHANNEL_TYPES,
  HOSTEX_RESERVATION_ORDER_FIELDS,
  HOSTEX_RESERVATION_STATUSES,
  HostexChannelType,
  HostexReservationOrderField,
  HostexReservationStatus,
} from './hostex.types';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class ListHostexPropertiesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tagId?: number;
}

export class ListHostexReservationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  reservationCode?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  channelId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  propertyId?: number;

  @IsOptional()
  @IsIn(HOSTEX_RESERVATION_STATUSES)
  status?: HostexReservationStatus;

  @IsOptional()
  @Matches(datePattern)
  startCheckInDate?: string;

  @IsOptional()
  @Matches(datePattern)
  endCheckInDate?: string;

  @IsOptional()
  @Matches(datePattern)
  startCheckOutDate?: string;

  @IsOptional()
  @Matches(datePattern)
  endCheckOutDate?: string;

  @IsOptional()
  @IsIn(HOSTEX_RESERVATION_ORDER_FIELDS)
  orderBy?: HostexReservationOrderField;

  @IsOptional()
  @IsIn(HOSTEX_CHANNEL_TYPES)
  channelType?: HostexChannelType;
}
