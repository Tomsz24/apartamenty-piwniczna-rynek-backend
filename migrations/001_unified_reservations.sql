BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE RESTRICT,
    origin text NOT NULL,
    status text NOT NULL DEFAULT 'confirmed',
    start_date date NOT NULL,
    end_date date NOT NULL,
    guest_name text,
    guest_count integer,
    adults integer,
    children integer,
    note text,
    created_by text NOT NULL DEFAULT 'system',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    cancelled_at timestamptz,
    last_seen_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT reservations_origin_check
        CHECK (origin IN ('manual', 'booking_email', 'booking_ical')),
    CONSTRAINT reservations_status_check
        CHECK (status IN ('confirmed', 'tentative', 'blocked', 'cancelled', 'needs_review')),
    CONSTRAINT reservations_dates_check CHECK (end_date > start_date),
    CONSTRAINT reservations_guest_count_check CHECK (guest_count IS NULL OR guest_count > 0),
    CONSTRAINT reservations_adults_check CHECK (adults IS NULL OR adults >= 0),
    CONSTRAINT reservations_children_check CHECK (children IS NULL OR children >= 0),
    CONSTRAINT reservations_version_check CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS reservations_apartment_dates_idx
    ON reservations (apartment_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS reservations_active_idx
    ON reservations (apartment_id, status, start_date)
    WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS reservation_source_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE RESTRICT,
    source_system text NOT NULL,
    external_id text NOT NULL,
    is_current boolean NOT NULL DEFAULT true,
    first_seen_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    missing_since timestamptz,
    raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT reservation_source_refs_source_check
        CHECK (source_system IN ('booking_email', 'booking_ical')),
    CONSTRAINT reservation_source_refs_external_id_check CHECK (length(external_id) > 0),
    CONSTRAINT reservation_source_refs_unique UNIQUE (apartment_id, source_system, external_id)
);

CREATE INDEX IF NOT EXISTS reservation_source_refs_reservation_idx
    ON reservation_source_refs (reservation_id);

CREATE TABLE IF NOT EXISTS orphaned_reservation_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE RESTRICT,
    source_system text NOT NULL,
    external_id text NOT NULL,
    note text NOT NULL,
    created_by text NOT NULL DEFAULT 'legacy',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    attached_to_reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
    attached_at timestamptz,
    CONSTRAINT orphaned_reservation_notes_unique UNIQUE (apartment_id, source_system, external_id)
);

-- Zachowujemy identyfikatory starych rezerwacji, aby istniejący frontend nie stracił odwołań.
INSERT INTO reservations (
    id,
    apartment_id,
    origin,
    status,
    start_date,
    end_date,
    note,
    created_by,
    created_at,
    updated_at
)
SELECT
    id,
    apartment_id,
    'manual',
    'confirmed',
    start_date,
    end_date,
    note,
    COALESCE(created_by, 'legacy'),
    NOW(),
    COALESCE(updated_at, NOW())
FROM bookings_manual
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservations (
    id,
    apartment_id,
    origin,
    status,
    start_date,
    end_date,
    created_by,
    created_at,
    updated_at,
    last_seen_at
)
SELECT
    id,
    apartment_id,
    'booking_ical',
    'confirmed',
    start_date,
    end_date,
    'ical-migration',
    COALESCE(last_synced_at, NOW()),
    COALESCE(last_synced_at, NOW()),
    COALESCE(last_synced_at, NOW())
FROM bookings_external
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservation_source_refs (
    reservation_id,
    apartment_id,
    source_system,
    external_id,
    first_seen_at,
    last_seen_at
)
SELECT
    id,
    apartment_id,
    'booking_ical',
    external_id,
    COALESCE(last_synced_at, NOW()),
    COALESCE(last_synced_at, NOW())
FROM bookings_external
WHERE external_id IS NOT NULL AND external_id <> ''
ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
    reservation_id = EXCLUDED.reservation_id,
    is_current = true,
    last_seen_at = EXCLUDED.last_seen_at,
    missing_since = NULL;

-- Notatki, których bieżący UID nadal istnieje, od razu trafiają do stabilnej rezerwacji.
UPDATE reservations AS reservation
SET
    note = notes.note,
    updated_at = GREATEST(reservation.updated_at, COALESCE(notes.updated_at, NOW())),
    version = reservation.version + 1
FROM bookings_external AS booking
JOIN external_booking_notes AS notes
    ON notes.apartment_id = booking.apartment_id
    AND notes.external_id = booking.external_id
WHERE reservation.id = booking.id
  AND notes.note IS NOT NULL
  AND notes.note <> ''
  AND (reservation.note IS NULL OR reservation.note = '');

-- Osieroconych notatek nie próbujemy zgadywać. Pokazujemy je administratorowi do przypisania.
INSERT INTO orphaned_reservation_notes (
    apartment_id,
    source_system,
    external_id,
    note,
    created_by,
    created_at,
    updated_at
)
SELECT
    notes.apartment_id,
    'booking_ical',
    notes.external_id,
    notes.note,
    COALESCE(notes.created_by, 'legacy'),
    COALESCE(notes.updated_at, NOW()),
    COALESCE(notes.updated_at, NOW())
FROM external_booking_notes AS notes
LEFT JOIN bookings_external AS booking
    ON booking.apartment_id = notes.apartment_id
    AND booking.external_id = notes.external_id
WHERE booking.id IS NULL
  AND notes.note IS NOT NULL
  AND notes.note <> ''
ON CONFLICT (apartment_id, source_system, external_id) DO UPDATE SET
    note = EXCLUDED.note,
    created_by = EXCLUDED.created_by,
    updated_at = EXCLUDED.updated_at;

COMMIT;
