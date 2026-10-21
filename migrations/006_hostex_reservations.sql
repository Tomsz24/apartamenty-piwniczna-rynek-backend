BEGIN;

ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_origin_check;
ALTER TABLE reservations
    ADD CONSTRAINT reservations_origin_check
    CHECK (origin IN ('manual', 'booking_email', 'booking_ical', 'hostex'));

ALTER TABLE reservation_source_refs
    DROP CONSTRAINT IF EXISTS reservation_source_refs_source_check;
ALTER TABLE reservation_source_refs
    ADD CONSTRAINT reservation_source_refs_source_check
    CHECK (source_system IN ('booking_email', 'booking_ical', 'hostex'));

ALTER TABLE reservation_review_items
    DROP CONSTRAINT IF EXISTS reservation_review_items_kind_check;
ALTER TABLE reservation_review_items
    ADD CONSTRAINT reservation_review_items_kind_check
    CHECK (
        kind IN (
            'ical_unmatched_block',
            'ical_observation_conflict',
            'reservation_missing_in_ical',
            'email_parse_failed',
            'email_reservation_conflict',
            'notification_delivery_failed',
            'manual_review',
            'hostex_reservation_conflict',
            'hostex_unknown_status'
        )
    );

CREATE TABLE IF NOT EXISTS hostex_property_mappings (
    hostex_property_id bigint PRIMARY KEY,
    apartment_id uuid NOT NULL UNIQUE REFERENCES apartments(id) ON DELETE RESTRICT,
    hostex_title text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT hostex_property_mappings_id_check CHECK (hostex_property_id > 0),
    CONSTRAINT hostex_property_mappings_title_check CHECK (length(trim(hostex_title)) > 0)
);

ALTER TABLE hostex_property_mappings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS hostex_property_mappings_apartment_idx
    ON hostex_property_mappings (apartment_id);

-- Hostex property 12761007 has address Rynek 3 and is the Rynek apartment.
-- 12761008 is the second of the two Hostex apartments and maps to Widok na góry.
INSERT INTO hostex_property_mappings (hostex_property_id, apartment_id, hostex_title)
SELECT mapping.hostex_property_id, apartment.id, mapping.hostex_title
FROM (VALUES
    (12761007::bigint, 'Apartament - Widok na rynek'::text, 'Property #1'::text),
    (12761008::bigint, 'Apartament - Widok na góry'::text, 'Property #2'::text)
) AS mapping(hostex_property_id, apartment_name, hostex_title)
JOIN apartments AS apartment
    ON lower(trim(apartment.name)) = lower(mapping.apartment_name)
WHERE NOT EXISTS (
    SELECT 1
    FROM hostex_property_mappings AS existing
    WHERE existing.hostex_property_id = mapping.hostex_property_id
       OR existing.apartment_id = apartment.id
)
ON CONFLICT DO NOTHING;

COMMIT;
