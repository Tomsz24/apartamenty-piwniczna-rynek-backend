import { HostexConversationDetails, HostexConversationMessage } from '../hostex/hostex.types';

export type NotificationPreferenceKey =
  | 'new_reservations'
  | 'new_messages'
  | 'reservation_updates'
  | 'cancellations'
  | 'access_code_errors'
  | 'arrival_message_reminder';

const PREFERENCE_BY_EVENT: Record<string, NotificationPreferenceKey> = {
  new_reservation: 'new_reservations',
  new_message: 'new_messages',
  reservation_modified: 'reservation_updates',
  reservation_cancelled: 'cancellations',
  access_code_error: 'access_code_errors',
  access_code_missing: 'access_code_errors',
  arrival_message_reminder: 'arrival_message_reminder',
  arrival_message_sent: 'arrival_message_reminder',
};

/** Preference column gating an event type; null means the event is always delivered. */
export function notificationPreferenceFor(eventType: string): NotificationPreferenceKey | null {
  return PREFERENCE_BY_EVENT[eventType] ?? null;
}

/** Push events older than this are kept in the inbox but never pushed (e.g. while APNs was off). */
export const NOTIFICATION_PUSH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const NOTIFICATION_MAX_ATTEMPTS = 5;

export function notificationRetryDelaySeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

export type ApnsPayloadInput = {
  id: string;
  eventType: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  badge: number;
};

export function buildApnsPayload(event: ApnsPayloadInput): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of ['reservationId', 'conversationId', 'accessCodeId']) {
    const value = event.payload[key];
    if (typeof value === 'string' && value) extra[key] = value;
  }
  return {
    aps: {
      alert: { title: truncate(event.title, 120), body: truncate(event.body, 240) },
      sound: 'default',
      badge: Math.max(0, Math.floor(event.badge)),
      'thread-id': event.eventType,
    },
    notificationId: event.id,
    eventType: event.eventType,
    ...extra,
  };
}

export type ApnsOutcome = 'sent' | 'retry' | 'invalid_token' | 'rejected';

/** Maps an APNs HTTP status/reason to what the dispatcher should do with the delivery. */
export function classifyApnsResponse(status: number, reason: string | null): ApnsOutcome {
  if (status === 200) return 'sent';
  if (status === 410) return 'invalid_token';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) {
    return 'invalid_token';
  }
  if (status === 429 || status >= 500) return 'retry';
  // ExpiredProviderToken and network-level issues are transient for us.
  if (status === 403 && reason === 'ExpiredProviderToken') return 'retry';
  return 'rejected';
}

export type IncomingMessageNotification = {
  messageId: string;
  title: string;
  body: string;
};

/**
 * Picks the guest message a `message_created` webhook refers to. Returns null
 * when the newest message is ours (we replied or the webhook is for our own send).
 */
export function latestIncomingMessage(
  conversation: HostexConversationDetails,
): IncomingMessageNotification | null {
  const messages = conversation.messages ?? [];
  if (messages.length === 0) return null;
  const latest = newestMessage(messages);
  if (!latest || latest.isOutgoing) return null;
  const text = latest.text.replace(/\s+/g, ' ').trim();
  return {
    messageId: latest.id || `${conversation.id}:${latest.sentAt ?? messages.length}`,
    title: `Nowa wiadomość${conversation.guestName ? ` — ${truncate(conversation.guestName, 60)}` : ''}`,
    body: text ? truncate(text, 180) : latest.attachments.length > 0 ? 'Załącznik' : 'Nowa wiadomość od gościa',
  };
}

function newestMessage(messages: HostexConversationMessage[]): HostexConversationMessage | null {
  const dated = messages.filter((message) => message.sentAt && Number.isFinite(Date.parse(message.sentAt)));
  if (dated.length === messages.length) {
    return [...dated].sort((a, b) => Date.parse(b.sentAt!) - Date.parse(a.sentAt!))[0];
  }
  // Without timestamps rely on the API order (oldest first).
  return messages[messages.length - 1];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
