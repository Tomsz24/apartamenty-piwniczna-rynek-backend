BEGIN;

CREATE TABLE IF NOT EXISTS booking_email_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL DEFAULT 'wp_imap',
    mailbox text NOT NULL DEFAULT 'booking',
    message_uid text NOT NULL,
    message_id text,
    booking_reservation_id text,
    event_type text,
    apartment_id uuid REFERENCES apartments(id) ON DELETE SET NULL,
    reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
    received_at timestamptz,
    processed_at timestamptz,
    parse_status text NOT NULL DEFAULT 'pending',
    parse_error text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT booking_email_messages_provider_check
        CHECK (provider IN ('wp_imap')),
    CONSTRAINT booking_email_messages_event_type_check
        CHECK (
            event_type IS NULL OR
            event_type IN (
                'reservation_created',
                'reservation_modified',
                'reservation_cancelled',
                'unknown'
            )
        ),
    CONSTRAINT booking_email_messages_parse_status_check
        CHECK (parse_status IN ('pending', 'parsed', 'ignored', 'failed', 'needs_review')),
    CONSTRAINT booking_email_messages_uid_check CHECK (length(message_uid) > 0),
    CONSTRAINT booking_email_messages_unique_uid UNIQUE (provider, mailbox, message_uid)
);

ALTER TABLE booking_email_messages ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS booking_email_messages_unique_message_id_idx
    ON booking_email_messages (provider, mailbox, message_id)
    WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_email_messages_booking_reservation_idx
    ON booking_email_messages (booking_reservation_id)
    WHERE booking_reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_email_messages_apartment_idx
    ON booking_email_messages (apartment_id)
    WHERE apartment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_email_messages_reservation_idx
    ON booking_email_messages (reservation_id)
    WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_email_messages_parse_status_idx
    ON booking_email_messages (parse_status, received_at);

CREATE TABLE IF NOT EXISTS ical_availability_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE RESTRICT,
    source_system text NOT NULL DEFAULT 'booking_ical',
    external_id text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    summary text,
    is_current boolean NOT NULL DEFAULT true,
    match_status text NOT NULL DEFAULT 'unmatched',
    matched_reservation_count integer NOT NULL DEFAULT 0,
    first_seen_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    missing_since timestamptz,
    raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT ical_availability_observations_source_check
        CHECK (source_system = 'booking_ical'),
    CONSTRAINT ical_availability_observations_external_id_check
        CHECK (length(external_id) > 0),
    CONSTRAINT ical_availability_observations_dates_check
        CHECK (end_date > start_date),
    CONSTRAINT ical_availability_observations_match_status_check
        CHECK (
            match_status IN (
                'unmatched',
                'matched_single',
                'matched_multiple',
                'conflict',
                'stale'
            )
        ),
    CONSTRAINT ical_availability_observations_match_count_check
        CHECK (matched_reservation_count >= 0),
    CONSTRAINT ical_availability_observations_unique
        UNIQUE (apartment_id, source_system, external_id)
);

ALTER TABLE ical_availability_observations ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS ical_availability_observations_apartment_dates_idx
    ON ical_availability_observations (apartment_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS ical_availability_observations_current_idx
    ON ical_availability_observations (apartment_id, is_current, start_date)
    WHERE is_current = true;

CREATE TABLE IF NOT EXISTS ical_observation_reservation_matches (
    observation_id uuid NOT NULL REFERENCES ical_availability_observations(id) ON DELETE CASCADE,
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    match_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT ical_observation_reservation_matches_type_check
        CHECK (match_type IN ('exact', 'covered_by', 'overlap')),
    CONSTRAINT ical_observation_reservation_matches_pkey
        PRIMARY KEY (observation_id, reservation_id)
);

ALTER TABLE ical_observation_reservation_matches ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS ical_observation_matches_reservation_idx
    ON ical_observation_reservation_matches (reservation_id);

CREATE TABLE IF NOT EXISTS reservation_review_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key text NOT NULL,
    apartment_id uuid REFERENCES apartments(id) ON DELETE SET NULL,
    reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
    observation_id uuid REFERENCES ical_availability_observations(id) ON DELETE SET NULL,
    kind text NOT NULL,
    severity text NOT NULL DEFAULT 'warning',
    status text NOT NULL DEFAULT 'open',
    title text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT reservation_review_items_dedupe_key_check CHECK (length(dedupe_key) > 0),
    CONSTRAINT reservation_review_items_kind_check
        CHECK (
            kind IN (
                'ical_unmatched_block',
                'ical_observation_conflict',
                'reservation_missing_in_ical',
                'email_parse_failed',
                'email_reservation_conflict',
                'notification_delivery_failed',
                'manual_review'
            )
        ),
    CONSTRAINT reservation_review_items_severity_check
        CHECK (severity IN ('info', 'warning', 'critical')),
    CONSTRAINT reservation_review_items_status_check
        CHECK (status IN ('open', 'resolved', 'dismissed')),
    CONSTRAINT reservation_review_items_unique_dedupe UNIQUE (dedupe_key)
);

ALTER TABLE reservation_review_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS reservation_review_items_open_idx
    ON reservation_review_items (status, severity, last_seen_at)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS reservation_review_items_apartment_idx
    ON reservation_review_items (apartment_id)
    WHERE apartment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reservation_review_items_reservation_idx
    ON reservation_review_items (reservation_id)
    WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reservation_review_items_observation_idx
    ON reservation_review_items (observation_id)
    WHERE observation_id IS NOT NULL;

-- Dotychczasowe aliasy iCal traktujemy jako obserwacje kalendarza, nie jako prawdę o rezerwacji.
INSERT INTO ical_availability_observations (
    apartment_id,
    source_system,
    external_id,
    start_date,
    end_date,
    summary,
    is_current,
    match_status,
    matched_reservation_count,
    first_seen_at,
    last_seen_at,
    missing_since,
    raw_data
)
SELECT
    refs.apartment_id,
    'booking_ical',
    refs.external_id,
    reservation.start_date,
    reservation.end_date,
    refs.raw_data ->> 'summary',
    refs.is_current,
    CASE WHEN refs.is_current THEN 'matched_single' ELSE 'stale' END,
    CASE WHEN refs.is_current THEN 1 ELSE 0 END,
    refs.first_seen_at,
    refs.last_seen_at,
    refs.missing_since,
    refs.raw_data
FROM reservation_source_refs AS refs
JOIN reservations AS reservation ON reservation.id = refs.reservation_id
WHERE refs.source_system = 'booking_ical'
ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
    start_date = EXCLUDED.start_date,
    end_date = EXCLUDED.end_date,
    summary = EXCLUDED.summary,
    is_current = EXCLUDED.is_current,
    match_status = EXCLUDED.match_status,
    matched_reservation_count = EXCLUDED.matched_reservation_count,
    last_seen_at = EXCLUDED.last_seen_at,
    missing_since = EXCLUDED.missing_since,
    raw_data = EXCLUDED.raw_data,
    updated_at = NOW();

INSERT INTO ical_observation_reservation_matches (
    observation_id,
    reservation_id,
    match_type
)
SELECT
    observation.id,
    refs.reservation_id,
    'exact'
FROM reservation_source_refs AS refs
JOIN ical_availability_observations AS observation
    ON observation.apartment_id = refs.apartment_id
    AND observation.source_system = refs.source_system
    AND observation.external_id = refs.external_id
WHERE refs.source_system = 'booking_ical'
  AND refs.is_current = true
ON CONFLICT (observation_id, reservation_id) DO NOTHING;

COMMIT;
