BEGIN;

CREATE TABLE IF NOT EXISTS notification_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id uuid,
    admin_email text NOT NULL,
    platform text NOT NULL,
    push_provider text NOT NULL,
    environment text NOT NULL DEFAULT 'production',
    device_token text NOT NULL,
    device_label text,
    app_id text,
    enabled boolean NOT NULL DEFAULT true,
    last_registered_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz,
    disabled_at timestamptz,
    failure_count integer NOT NULL DEFAULT 0,
    last_error text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT notification_devices_platform_check
        CHECK (platform IN ('ios', 'android', 'web')),
    CONSTRAINT notification_devices_push_provider_check
        CHECK (push_provider IN ('apns', 'fcm', 'web_push')),
    CONSTRAINT notification_devices_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT notification_devices_token_check CHECK (length(device_token) > 0),
    CONSTRAINT notification_devices_failure_count_check CHECK (failure_count >= 0),
    CONSTRAINT notification_devices_unique_token
        UNIQUE (push_provider, environment, device_token)
);

ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS notification_devices_admin_email_idx
    ON notification_devices (admin_email)
    WHERE enabled = true;

CREATE INDEX IF NOT EXISTS notification_devices_admin_user_idx
    ON notification_devices (admin_user_id)
    WHERE admin_user_id IS NOT NULL AND enabled = true;

CREATE TABLE IF NOT EXISTS notification_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key text,
    event_type text NOT NULL,
    priority text NOT NULL DEFAULT 'normal',
    status text NOT NULL DEFAULT 'pending',
    apartment_id uuid REFERENCES apartments(id) ON DELETE SET NULL,
    reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
    review_item_id uuid REFERENCES reservation_review_items(id) ON DELETE SET NULL,
    title text NOT NULL,
    body text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    scheduled_for timestamptz NOT NULL DEFAULT NOW(),
    attempt_count integer NOT NULL DEFAULT 0,
    last_error text,
    sent_at timestamptz,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT notification_events_event_type_check
        CHECK (
            event_type IN (
                'new_reservation',
                'reservation_modified',
                'reservation_cancelled',
                'manual_block_created',
                'ical_mismatch',
                'email_parse_failed',
                'door_opened',
                'access_code_missing',
                'system_alert'
            )
        ),
    CONSTRAINT notification_events_priority_check
        CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    CONSTRAINT notification_events_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
    CONSTRAINT notification_events_attempt_count_check CHECK (attempt_count >= 0),
    CONSTRAINT notification_events_unique_dedupe UNIQUE (dedupe_key)
);

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS notification_events_pending_idx
    ON notification_events (status, scheduled_for, priority)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notification_events_apartment_idx
    ON notification_events (apartment_id)
    WHERE apartment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_events_reservation_idx
    ON notification_events (reservation_id)
    WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_events_review_item_idx
    ON notification_events (review_item_id)
    WHERE review_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    device_id uuid REFERENCES notification_devices(id) ON DELETE SET NULL,
    push_provider text NOT NULL,
    device_token_snapshot text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    provider_message_id text,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT notification_deliveries_push_provider_check
        CHECK (push_provider IN ('apns', 'fcm', 'web_push')),
    CONSTRAINT notification_deliveries_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
    CONSTRAINT notification_deliveries_attempt_count_check CHECK (attempt_count >= 0),
    CONSTRAINT notification_deliveries_token_snapshot_check CHECK (length(device_token_snapshot) > 0),
    CONSTRAINT notification_deliveries_unique_device
        UNIQUE (notification_event_id, device_id)
);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx
    ON notification_deliveries (status, created_at)
    WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS notification_deliveries_device_idx
    ON notification_deliveries (device_id)
    WHERE device_id IS NOT NULL;

COMMIT;
