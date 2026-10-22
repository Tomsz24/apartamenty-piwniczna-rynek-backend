BEGIN;

-- Automatic arrival messages sent through the Hostex chat (Booking.com and other
-- channel stays). One row per stay; it is claimed before anything is sent, so a
-- restart or a second backend can never message the guest twice. The message
-- text contains the door code and is therefore never stored here.
CREATE TABLE IF NOT EXISTS public.arrival_message_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
    stay_start_date date NOT NULL,
    channel text NOT NULL DEFAULT 'hostex_chat',
    status text NOT NULL DEFAULT 'sending',
    attempts integer NOT NULL DEFAULT 1,
    image_sent boolean NOT NULL DEFAULT false,
    triggered_by text NOT NULL,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT arrival_message_deliveries_channel_check CHECK (channel IN ('hostex_chat')),
    -- failed: certainly not delivered, may be retried; uncertain: the result is
    -- unknown (timeout), never retried automatically.
    CONSTRAINT arrival_message_deliveries_status_check
        CHECK (status IN ('sending', 'sent', 'failed', 'uncertain')),
    CONSTRAINT arrival_message_deliveries_attempts_check CHECK (attempts >= 0),
    CONSTRAINT arrival_message_deliveries_one_per_stay UNIQUE (reservation_id, stay_start_date)
);

ALTER TABLE public.arrival_message_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.arrival_message_deliveries FROM anon, authenticated;

ALTER TABLE public.notification_events
    DROP CONSTRAINT IF EXISTS notification_events_event_type_check;
ALTER TABLE public.notification_events
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
            'access_code_error',
            'arrival_message_reminder',
            'arrival_message_sent',
            'arrival_message_failed',
            'system_alert'
        )
    );

COMMIT;
