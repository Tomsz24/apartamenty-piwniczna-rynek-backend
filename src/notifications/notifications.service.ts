import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { UpdateNotificationPreferencesDto } from './notifications.dto';

export type AdminIdentity = { id: string; email: string };

export type NotificationInboxItem = {
  id: string;
  eventType: string;
  priority: string;
  status: string;
  title: string;
  body: string;
  apartmentId: string | null;
  apartmentName: string | null;
  reservationId: string | null;
  guestName: string | null;
  createdAt: string;
  readAt: string | null;
};

@Injectable()
export class NotificationsService {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async getInbox(admin: AdminIdentity): Promise<{ items: NotificationInboxItem[]; unreadCount: number }> {
    const [items, unread] = await Promise.all([
      this.pool.query<NotificationInboxItem>(
        `SELECT e.id, e.event_type AS "eventType", e.priority, e.status,
                e.title, e.body, e.apartment_id AS "apartmentId",
                a.name AS "apartmentName", e.reservation_id AS "reservationId",
                r.guest_name AS "guestName", e.created_at AS "createdAt",
                reads.read_at AS "readAt"
         FROM notification_events e
         LEFT JOIN apartments a ON a.id = e.apartment_id
         LEFT JOIN reservations r ON r.id = e.reservation_id
         LEFT JOIN notification_event_reads reads
           ON reads.notification_event_id = e.id AND reads.admin_user_id = $1
         WHERE e.status <> 'cancelled'
         ORDER BY e.created_at DESC
         LIMIT 100`,
        [admin.id],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM notification_events e
         WHERE e.status <> 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM notification_event_reads reads
             WHERE reads.notification_event_id = e.id AND reads.admin_user_id = $1
           )`,
        [admin.id],
      ),
    ]);
    return { items: items.rows, unreadCount: Number(unread.rows[0]?.count ?? 0) };
  }

  async markInboxItemRead(admin: AdminIdentity, notificationId: string): Promise<{ read: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO notification_event_reads (notification_event_id, admin_user_id, read_at)
       SELECT id, $2, NOW() FROM notification_events
       WHERE id = $1 AND status <> 'cancelled'
       ON CONFLICT (notification_event_id, admin_user_id) DO UPDATE SET read_at = NOW()
       RETURNING notification_event_id`,
      [notificationId, admin.id],
    );
    return { read: result.rowCount === 1 };
  }

  async markAllInboxRead(admin: AdminIdentity): Promise<{ markedRead: number }> {
    const result = await this.pool.query(
      `INSERT INTO notification_event_reads (notification_event_id, admin_user_id, read_at)
       SELECT id, $1, NOW() FROM notification_events WHERE status <> 'cancelled'
       ON CONFLICT (notification_event_id, admin_user_id) DO NOTHING`,
      [admin.id],
    );
    return { markedRead: result.rowCount ?? 0 };
  }

  async registerDevice(
    admin: AdminIdentity,
    input: { deviceToken: string; environment: 'sandbox' | 'production'; appId: string },
  ) {
    const result = await this.pool.query(
      `INSERT INTO notification_devices (
         admin_user_id, admin_email, platform, push_provider, environment,
         device_token, app_id, enabled, last_registered_at, last_seen_at,
         disabled_at, failure_count, last_error, updated_at
       ) VALUES ($1, $2, 'ios', 'apns', $3, $4, $5, true, NOW(), NOW(), NULL, 0, NULL, NOW())
       ON CONFLICT (push_provider, environment, device_token) DO UPDATE SET
         admin_user_id = EXCLUDED.admin_user_id,
         admin_email = EXCLUDED.admin_email,
         app_id = EXCLUDED.app_id,
         enabled = true,
         last_registered_at = NOW(),
         last_seen_at = NOW(),
         disabled_at = NULL,
         failure_count = 0,
         last_error = NULL,
         updated_at = NOW()
       RETURNING id, enabled`,
      [admin.id, admin.email, input.environment, input.deviceToken.toLowerCase(), input.appId],
    );
    return { registered: true, deviceId: result.rows[0].id as string };
  }

  async unregisterDevice(
    admin: AdminIdentity,
    input: { deviceToken: string; environment: 'sandbox' | 'production' },
  ) {
    await this.pool.query(
      `UPDATE notification_devices
       SET enabled = false, disabled_at = NOW(), updated_at = NOW()
       WHERE push_provider = 'apns' AND environment = $1 AND device_token = $2
         AND (admin_user_id = $3 OR admin_email = $4)`,
      [input.environment, input.deviceToken.toLowerCase(), admin.id, admin.email],
    );
    return { unregistered: true };
  }

  async getPreferences(admin: AdminIdentity): Promise<UpdateNotificationPreferencesDto> {
    const result = await this.pool.query(
      `SELECT new_reservations AS "newReservations",
              new_messages AS "newMessages",
              reservation_updates AS "reservationUpdates",
              cancellations,
              access_code_errors AS "accessCodeErrors",
              arrival_message_reminder AS "arrivalMessageReminder"
       FROM notification_preferences WHERE admin_user_id = $1 OR admin_email = $2
       LIMIT 1`,
      [admin.id, admin.email],
    );
    if (result.rows[0]) return result.rows[0] as UpdateNotificationPreferencesDto;
    return {
      newReservations: true,
      newMessages: true,
      reservationUpdates: true,
      cancellations: true,
      accessCodeErrors: true,
      arrivalMessageReminder: true,
    };
  }

  async updatePreferences(
    admin: AdminIdentity,
    preferences: UpdateNotificationPreferencesDto,
  ): Promise<UpdateNotificationPreferencesDto> {
    const result = await this.pool.query(
      `INSERT INTO notification_preferences (
         admin_user_id, admin_email, new_reservations, new_messages,
         reservation_updates, cancellations, access_code_errors,
         arrival_message_reminder, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (admin_user_id) DO UPDATE SET
         admin_email = EXCLUDED.admin_email,
         new_reservations = EXCLUDED.new_reservations,
         new_messages = EXCLUDED.new_messages,
         reservation_updates = EXCLUDED.reservation_updates,
         cancellations = EXCLUDED.cancellations,
         access_code_errors = EXCLUDED.access_code_errors,
         arrival_message_reminder = EXCLUDED.arrival_message_reminder,
         updated_at = NOW()
       RETURNING new_reservations AS "newReservations",
                 new_messages AS "newMessages",
                 reservation_updates AS "reservationUpdates",
                 cancellations,
                 access_code_errors AS "accessCodeErrors",
                 arrival_message_reminder AS "arrivalMessageReminder"`,
      [
        admin.id,
        admin.email,
        preferences.newReservations,
        preferences.newMessages,
        preferences.reservationUpdates,
        preferences.cancellations,
        preferences.accessCodeErrors,
        preferences.arrivalMessageReminder,
      ],
    );
    return result.rows[0] as UpdateNotificationPreferencesDto;
  }
}
