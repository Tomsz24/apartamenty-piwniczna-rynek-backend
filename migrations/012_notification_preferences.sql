BEGIN;

CREATE TABLE IF NOT EXISTS notification_preferences (
    admin_user_id uuid PRIMARY KEY,
    admin_email text NOT NULL UNIQUE,
    new_reservations boolean NOT NULL DEFAULT true,
    new_messages boolean NOT NULL DEFAULT true,
    reservation_updates boolean NOT NULL DEFAULT true,
    cancellations boolean NOT NULL DEFAULT true,
    access_code_errors boolean NOT NULL DEFAULT true,
    arrival_message_reminder boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE notification_preferences FROM anon, authenticated;

COMMIT;
