import { BadGatewayException } from '@nestjs/common';
import {
  HostexChannelSummary,
  HostexConversationDetails,
  HostexConversationMessage,
  HostexConversationSummary,
  HostexNamedReference,
  HostexPage,
  HostexPropertySummary,
  HostexReservationSummary,
  HostexTagSummary,
} from './hostex.types';

type UnknownRecord = Record<string, unknown>;

export function sanitizeHostexConversations(
  data: unknown,
  offset: number,
  limit: number,
): HostexPage<HostexConversationSummary> {
  const record = asRecord(data);
  const values = Array.isArray(data)
    ? data
    : record?.conversations ?? record?.items;
  if (!Array.isArray(values)) {
    throw new BadGatewayException('Hostex zwrócił nieprawidłową listę rozmów');
  }
  const items = values.map((value, index) => sanitizeConversation(value, index));
  return {
    items,
    total: asNonNegativeInteger(record?.total) ?? items.length,
    offset,
    limit,
  };
}

export function sanitizeHostexConversation(data: unknown, conversationId: string): HostexConversationDetails {
  const outer = asRecord(data);
  const record = asRecord(outer?.conversation) ?? outer;
  if (!record) throw new BadGatewayException('Hostex zwrócił nieprawidłową rozmowę');
  const summary = sanitizeConversation(record, 0, conversationId);
  const rawMessages = record.messages ?? asRecord(record.data)?.messages;
  if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
    throw new BadGatewayException('Hostex zwrócił nieprawidłową historię rozmowy');
  }
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map((message, index) => sanitizeConversationMessage(message, index))
    : [];
  return { ...summary, messages };
}

function sanitizeConversation(value: unknown, index: number, fallbackId?: string): HostexConversationSummary {
  const record = asRecord(value);
  if (!record) throw new BadGatewayException('Hostex zwrócił nieprawidłowy wątek rozmowy');
  const guest = asRecord(record.guest);
  const booking = asRecord(record.reservation) ?? asRecord(record.booking);
  const id = asNonEmptyString(record.id ?? record.conversation_id) ?? fallbackId;
  if (!id) throw new BadGatewayException('Hostex zwrócił rozmowę bez identyfikatora');
  const lastMessage = record.last_message ?? record.latest_message ?? record.lastMessage;
  const unread = record.unread_count ?? record.unread_messages ?? record.unread ?? record.unreadCount;
  return {
    id,
    channelType: asNonEmptyString(record.channel_type ?? record.channelType) ?? 'unknown',
    lastMessageAt: asNullableDateTimeString(record.last_message_at ?? record.lastMessageAt),
    guestName: asNullableString(record.guest_name ?? guest?.name ?? guest?.guest_name ?? record.name),
    propertyTitle: asNullableString(
      record.property_title ?? guest?.property_title ?? asRecord(record.property)?.title ?? booking?.property_title,
    ),
    checkInDate: asNullableDateString(
      record.check_in_date ?? guest?.check_in_date ?? booking?.check_in_date ?? booking?.checkInDate,
    ),
    checkOutDate: asNullableDateString(
      record.check_out_date ?? guest?.check_out_date ?? booking?.check_out_date ?? booking?.checkOutDate,
    ),
    reservationCode: asNullableString(record.reservation_code ?? booking?.reservation_code ?? booking?.code),
    lastMessage: asNullableString(
      typeof lastMessage === 'string'
        ? lastMessage
        : asRecord(lastMessage)?.content ?? asRecord(lastMessage)?.message ?? asRecord(lastMessage)?.text ?? record.last_message_preview,
    ),
    unreadCount: typeof unread === 'boolean' ? (unread ? 1 : 0) : asNonNegativeInteger(unread) ?? 0,
  };
}

function sanitizeConversationMessage(value: unknown, index: number): HostexConversationMessage {
  const record = asRecord(value);
  if (!record) throw new BadGatewayException('Hostex zwrócił nieprawidłową wiadomość');
  const rawId = record.id ?? record.message_id;
  // Hostex message payloads use `sender_role` (`host` / `guest`). Keep the
  // other variants too, since older channel payloads can expose sender metadata
  // under a different field or as an object.
  const senderValues = [record.sender_role, record.sender, record.direction, record.role, record.author];
  const senderTexts = senderValues.flatMap((sender) => {
    if (typeof sender === 'string') return [sender.toLowerCase()];
    const senderRecord = asRecord(sender);
    return [senderRecord?.role, senderRecord?.type, senderRecord?.name]
      .flatMap((value) => typeof value === 'string' ? [value.toLowerCase()] : []);
  });
  const explicitOutgoing = record.is_outgoing ?? record.outgoing ?? record.is_host_message;
  const isOutgoing = typeof explicitOutgoing === 'boolean'
    ? explicitOutgoing
    : senderTexts.some((senderText) =>
        ['host', 'outgoing', 'outbound', 'owner', 'operator', 'sent_by_host', 'sent'].some((part) => senderText.includes(part)),
      );
  const rawContent = record.content ?? record.message ?? record.text ?? record.body;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((part) => asRecord(part)?.text).filter((part): part is string => typeof part === 'string').join('\n')
      : '';
  const attachmentsValue = record.attachments ?? record.attachment;
  const attachments = (Array.isArray(attachmentsValue) ? attachmentsValue : attachmentsValue ? [attachmentsValue] : [])
    .flatMap((attachment) => {
      if (typeof attachment === 'string') return [attachment];
      const item = asRecord(attachment);
      const url = asNonEmptyString(item?.url ?? item?.file_url ?? item?.image_url);
      return url ? [url] : [];
    });
  return {
    id: asNonEmptyString(rawId) ?? `message-${index}`,
    text,
    isOutgoing,
    sentAt: asNullableDateTimeString(record.created_at ?? record.sent_at ?? record.timestamp ?? record.time),
    attachments,
  };
}

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

  const rates = asRecord(record.rates);
  const totalRate = asRecord(rates?.total_rate);
  const payment = asRecord(record.payment);

  return {
    reservationCode,
    stayCode,
    channelId: asNullableString(record.channel_id),
    propertyId,
    channelType,
    conversationId: asNullableString(record.conversation_id),
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
    guestPhone: asNullableString(record.guest_phone),
    guestEmail: asNullableString(record.guest_email),
    totalRateAmount: asNonNegativeNumber(totalRate?.amount),
    amountReceived: asNonNegativeNumber(
      payment?.amount_received ?? payment?.received_amount ??
      record.amount_received ?? record.received_amount,
    ),
    currency: asNullableString(totalRate?.currency ?? payment?.currency ?? record.currency),
    paymentStatus: asNullableString(
      payment?.status ?? payment?.payment_status ?? payment?.collection_status ?? record.payment_status,
    ),
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

function asNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function asDateString(value: unknown): string | null {
  const parsed = asNonEmptyString(value);
  return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : null;
}

function asNullableDateString(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : asDateString(value);
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
