import { BadGatewayException } from '@nestjs/common';
import {
  HostexChannelSummary,
  HostexNamedReference,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
  HostexTagSummary,
} from './hostex.types';

type UnknownRecord = Record<string, unknown>;

export function sanitizeHostexProperties(
  data: unknown,
  offset: number,
  limit: number,
): HostexPage<HostexPropertySummary> {
  const record = asRecord(data);
  if (!record || !Array.isArray(record.properties)) {
    throw new BadGatewayException('Hostex zwrócił nieprawidłową listę obiektów');
  }

  const items = record.properties.map((value) => sanitizeProperty(value));
  return {
    items,
    total: asNonNegativeInteger(record.total) ?? items.length,
    offset,
    limit,
  };
}

export function sanitizeHostexReservations(
  data: unknown,
  offset: number,
  limit: number,
): HostexPage<HostexReservationSummary> {
  const record = asRecord(data);
  if (!record || !Array.isArray(record.reservations)) {
    throw new BadGatewayException('Hostex zwrócił nieprawidłową listę rezerwacji');
  }

  const items = record.reservations.map((value) => sanitizeReservation(value));
  return {
    items,
    total: asNonNegativeInteger(record.total) ?? items.length,
    offset,
    limit,
  };
}

function sanitizeProperty(value: unknown): HostexPropertySummary {
  const record = asRecord(value);
  const id = asPositiveInteger(record?.id);
  const title = asNonEmptyString(record?.title);
  if (!record || id === null || !title) {
    throw new BadGatewayException('Hostex zwrócił niepełne dane obiektu');
  }

  return {
    id,
    title,
    address: asNullableString(record.address),
    longitude: asNullableString(record.longitude),
    latitude: asNullableString(record.latitude),
    channels: sanitizeArray(record.channels, sanitizeChannel),
    groups: sanitizeArray(record.groups, sanitizeNamedReference),
    tags: sanitizeArray(record.tags, sanitizeTag),
  };
}

function sanitizeReservation(value: unknown): HostexReservationSummary {
  const record = asRecord(value);
  const reservationCode = asNonEmptyString(record?.reservation_code);
  const stayCode = asNonEmptyString(record?.stay_code);
  const propertyId = asNonNegativeInteger(record?.property_id);
  const channelType = asNonEmptyString(record?.channel_type);
  const checkInDate = asDateString(record?.check_in_date);
  const checkOutDate = asDateString(record?.check_out_date);
  const status = asNonEmptyString(record?.status);
  const bookedAt = asDateTimeString(record?.booked_at);
  const createdAt = asDateTimeString(record?.created_at);

  if (
    !record ||
    !reservationCode ||
    !stayCode ||
    propertyId === null ||
    !channelType ||
    !checkInDate ||
    !checkOutDate ||
    !status ||
    !bookedAt ||
    !createdAt
  ) {
    throw new BadGatewayException('Hostex zwrócił niepełne dane rezerwacji');
  }

  return {
    reservationCode,
    stayCode,
    channelId: asNullableString(record.channel_id),
    propertyId,
    channelType,
    listingId: asNullableString(record.listing_id),
    checkInDate,
    checkOutDate,
    numberOfGuests: asNonNegativeInteger(record.number_of_guests),
    numberOfAdults: asNonNegativeInteger(record.number_of_adults),
    numberOfChildren: asNonNegativeInteger(record.number_of_children),
    numberOfInfants: asNonNegativeInteger(record.number_of_infants),
    numberOfPets: asNonNegativeInteger(record.number_of_pets),
    status,
    guestName: asNullableString(record.guest_name),
    cancelledAt: asNullableDateTimeString(record.cancelled_at),
    bookedAt,
    createdAt,
  };
}

function sanitizeChannel(value: unknown): HostexChannelSummary | null {
  const record = asRecord(value);
  const channelType = asNonEmptyString(record?.channel_type);
  const listingId = asNonEmptyString(record?.listing_id);
  if (!record || !channelType || !listingId) return null;
  return {
    channelType,
    listingId,
    currency: asNullableString(record.currency),
  };
}

function sanitizeNamedReference(value: unknown): HostexNamedReference | null {
  const record = asRecord(value);
  const id = asPositiveInteger(record?.id);
  const name = asNonEmptyString(record?.name);
  if (!record || id === null || !name) return null;
  return { id, name };
}

function sanitizeTag(value: unknown): HostexTagSummary | null {
  const reference = sanitizeNamedReference(value);
  const record = asRecord(value);
  if (!reference || !record) return null;
  return { ...reference, color: asNullableString(record.color) };
}

function sanitizeArray<T>(
  value: unknown,
  mapper: (item: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(mapper).filter((item): item is T => item !== null);
}

function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asNonEmptyString(value);
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asDateString(value: unknown): string | null {
  const parsed = asNonEmptyString(value);
  return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : null;
}

function asDateTimeString(value: unknown): string | null {
  const parsed = asNonEmptyString(value);
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
}

function asNullableDateTimeString(value: unknown): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : asDateTimeString(value);
}
