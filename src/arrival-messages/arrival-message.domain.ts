import { BadGatewayException, GatewayTimeoutException } from '@nestjs/common';

export type ArrivalDeliveryChannel = 'hostex_chat' | 'imessage';

/**
 * Channel stays (Booking.com, Airbnb, …) have a Hostex conversation and get the
 * message automatically in that chat. Manual and app-created direct stays have
 * no channel chat, so the owner sends it from the phone via iMessage.
 */
export function arrivalDeliveryChannel(params: {
  origin: string;
  channelType: string | null;
  conversationId: string | null;
}): ArrivalDeliveryChannel {
  const viaChannel =
    params.origin === 'hostex' &&
    Boolean(params.conversationId) &&
    Boolean(params.channelType) &&
    params.channelType !== 'hostex_direct';
  return viaChannel ? 'hostex_chat' : 'imessage';
}

/** Fills the apartment template; returns null while a placeholder still has no value. */
export function renderArrivalMessage(
  template: string,
  values: {
    accessCode: string;
    validFrom: Date;
    validUntil: Date;
    timeZone: string;
    arrivalDate?: string;
    departureDate?: string;
  },
): string {
  const replacements: Record<string, string> = {
    apartment_access_code: values.accessCode,
    ...(values.arrivalDate ? { arrival_date: formatStayDate(values.arrivalDate) } : {}),
    ...(values.departureDate ? { departure_date: formatStayDate(values.departureDate) } : {}),
    access_code_valid_from: formatValidity(values.validFrom, values.timeZone),
    access_code_valid_until: formatValidity(values.validUntil, values.timeZone),
  };
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string, offset: number, text: string) => {
      const value = replacements[key];
      if (value === undefined) return match;
      // The lock only accepts a code confirmed with "#"; add it unless the template already does.
      if (key === 'apartment_access_code' && text[offset + match.length] !== '#') return `${value}#`;
      return value;
    })
    .trim();
}

/** Fields an arrival template may use; the app shows them as a legend while editing. */
export const ARRIVAL_TEMPLATE_PLACEHOLDERS = [
  { key: 'apartment_access_code', label: 'Kod do drzwi (z # na końcu)' },
  { key: 'arrival_date', label: 'Data przyjazdu' },
  { key: 'departure_date', label: 'Data wyjazdu' },
  { key: 'access_code_valid_from', label: 'Kod ważny od' },
  { key: 'access_code_valid_until', label: 'Kod ważny do' },
] as const;

export const ARRIVAL_TEMPLATE_MAX_LENGTH = 4000;

/** Why a template cannot be saved, or null when it is fine. */
export function arrivalTemplateError(body: string): string | null {
  const text = body.trim();
  if (!text) return 'Szablon nie może być pusty';
  if (text.length > ARRIVAL_TEMPLATE_MAX_LENGTH) {
    return `Szablon może mieć najwyżej ${ARRIVAL_TEMPLATE_MAX_LENGTH} znaków`;
  }
  const known = new Set<string>(ARRIVAL_TEMPLATE_PLACEHOLDERS.map((item) => item.key));
  const unknown = [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((key) => !known.has(key));
  if (unknown.length > 0) return `Nieznane pole: {{${unknown[0]}}}`;
  if (!/\{\{\s*apartment_access_code\s*\}\}/.test(text)) {
    return 'Szablon musi zawierać pole {{apartment_access_code}} — bez niego gość nie dostanie kodu';
  }
  return null;
}

export function hasUnfilledPlaceholders(text: string): boolean {
  return /\{\{\s*[a-z_]+\s*\}\}/.test(text);
}

/** "2026-10-23" (a stay date) as "23-10-2026". */
export function formatStayDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}-${month}-${year}`;
}

/** "12:00 23-10-2026" in the apartment's time zone, as in the owner's own messages. */
export function formatValidity(value: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('pl-PL', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute} ${parts.day}-${parts.month}-${parts.year}`;
}

/**
 * Hostex messages are not idempotent and return no message id. A rejection by
 * Hostex means nothing was sent and may be retried; a timeout, lost connection
 * or 5xx leaves the outcome unknown, and a duplicate to the guest is worse than
 * asking the owner to check the chat.
 */
export function classifyHostexSendError(error: unknown): 'failed' | 'uncertain' {
  if (error instanceof GatewayTimeoutException) return 'uncertain';
  if (error instanceof BadGatewayException) {
    const message = error.message ?? '';
    if (/połączyć|HTTP 5\d\d|nieprawidłową odpowiedź/i.test(message)) return 'uncertain';
  }
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
    return 'uncertain';
  }
  return 'failed';
}
