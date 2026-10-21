BEGIN;

ALTER TABLE notification_events
    DROP CONSTRAINT IF EXISTS notification_events_event_type_check;

ALTER TABLE notification_events
    ADD CONSTRAINT notification_events_event_type_check
    CHECK (
        event_type IN (
            'new_reservation',
            'new_message',
            'reservation_modified',
            'reservation_cancelled',
            'manual_block_created',
            'ical_mismatch',
            'email_parse_failed',
            'door_opened',
            'access_code_missing',
            'system_alert'
        )
    );

CREATE INDEX IF NOT EXISTS notification_events_inbox_created_at_idx
    ON notification_events (created_at DESC)
    WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS notification_event_reads (
    notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    admin_user_id uuid NOT NULL,
    read_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_event_id, admin_user_id)
);

ALTER TABLE notification_event_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE notification_event_reads FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS notification_event_reads_admin_idx
    ON notification_event_reads (admin_user_id, read_at DESC);

COMMIT;
