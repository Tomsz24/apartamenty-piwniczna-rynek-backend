import { createHash, timingSafeEqual } from 'crypto';

export type HostexWebhookAction = 'sync_reservation' | 'new_message' | 'authorization_revoked' | 'ignore';

export type ParsedHostexWebhook = {
  dedupeKey: string;
  eventId: string | null;
  eventType: string;
  reservationCode: string | null;
  stayCode: string | null;
  propertyId: number | null;
  conversationId: string | null;
  payloadKeys: string[];
};

const RESERVATION_EVENTS = new Set(['reservation_created', 'reservation_updated']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
// Hostex documents only `event` and `event_id`; identifiers may sit at the top
// level or inside a nested object, so look one level deep in these containers.
const NESTED_CONTAINERS = ['data', 'reservation', 'message', 'conversation', 'payload', 'object'];

export function verifyHostexWebhookSecret(expected: string, received: unknown): boolean {
  if (!expected || typeof received !== 'string' || !received) return false;
  // Hash first so the comparison is constant-time regardless of input length.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(received).digest();
  return timingSafeEqual(a, b);
}

export function parseHostexWebhook(body: unknown): ParsedHostexWebhook | null {
  const record = asRecord(body);
  if (!record) return null;
  const eventType = typeof record.event === 'string' ? record.event.trim() : '';
  if (!/^[a-z0-9_.]{1,80}$/.test(eventType)) return null;

  const eventId = identifier(record.event_id);
  const nested = NESTED_CONTAINERS.map((key) => asRecord(record[key])).filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const pick = (key: string) =>
    [record, ...nested].map((source) => source[key]).find((value) => value !== undefined);
  const propertyId = Number(pick('property_id'));

  return {
    dedupeKey: eventId
      ? `event:${eventId}`
      : `body:${createHash('sha256').update(stableStringify(record)).digest('hex')}`,
    eventId,
    eventType,
    reservationCode: identifier(pick('reservation_code')),
    stayCode: identifier(pick('stay_code')),
    propertyId: Number.isSafeInteger(propertyId) && propertyId > 0 ? propertyId : null,
    conversationId: identifier(pick('conversation_id')),
    payloadKeys: Object.keys(record).filter((key) => /^[A-Za-z0-9_]{1,60}$/.test(key)).sort().slice(0, 40),
  };
}

export function hostexWebhookAction(eventType: string): HostexWebhookAction {
  if (RESERVATION_EVENTS.has(eventType)) return 'sync_reservation';
  if (eventType === 'message_created') return 'new_message';
  if (eventType === 'authorization_revoked') return 'authorization_revoked';
  return 'ignore';
}

export function hostexWebhookRetryDelayMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

function identifier(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && IDENTIFIER_PATTERN.test(text.trim()) ? text.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = asRecord(value);
  if (!record) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
