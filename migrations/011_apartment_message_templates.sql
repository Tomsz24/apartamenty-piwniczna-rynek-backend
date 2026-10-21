BEGIN;

CREATE TABLE IF NOT EXISTS apartment_message_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
    message_type text NOT NULL DEFAULT 'arrival',
    body text NOT NULL,
    attachment_bucket_id text,
    attachment_path text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT apartment_message_templates_type_check
        CHECK (message_type IN ('arrival')),
    CONSTRAINT apartment_message_templates_body_check
        CHECK (length(trim(body)) > 0),
    CONSTRAINT apartment_message_templates_attachment_check
        CHECK (
            (attachment_bucket_id IS NULL AND attachment_path IS NULL)
            OR (attachment_bucket_id IS NOT NULL AND attachment_path IS NOT NULL)
        ),
    CONSTRAINT apartment_message_templates_apartment_type_unique
        UNIQUE (apartment_id, message_type)
);

ALTER TABLE apartment_message_templates ENABLE ROW LEVEL SECURITY;

-- Templates contain door-access instructions. They are read by the backend
-- with its privileged database connection, never directly by mobile clients.
REVOKE ALL ON TABLE apartment_message_templates FROM anon, authenticated;
GRANT ALL ON TABLE apartment_message_templates TO service_role;

INSERT INTO apartment_message_templates (
    apartment_id,
    message_type,
    body,
    attachment_bucket_id,
    attachment_path,
    is_active
)
SELECT
    apartment.id,
    'arrival',
    template.body,
    'arrival-message-assets',
    'apartments-map.jpg',
    true
FROM (
    VALUES
        (
            'Apartament - Widok na góry',
            $mountain$
Dzień dobry
Kod dostępu do Państwa apartamentu (Apartament z widokiem na góry) to {{apartment_access_code}}

Kod dostępu do głównych drzwi do budynku to 1407#

Kody będą ważne
Od {{access_code_valid_from}}
Do {{access_code_valid_until}}

Dodatkowa informacja: świetlik w sypialni wyposażony jest w automatyczną roletę, sterowaną przyciskami znajdującymi się za zasłoną.

Do Państwa dyspozycji pozostają również suszarka na pranie, żelazko, deska do prasowania, a także miotła i mop, znajdują się one w szafie na korytarzu.

Życzymy udanego i komfortowego pobytu!
$mountain$
        ),
        (
            'Apartament - Widok na rynek',
            $market$
Dzień dobry
Kod dostępu do Państwa apartamentu (Apartament z widokiem na rynek) to {{apartment_access_code}}

Kod dostępu do głównych drzwi do budynku to 1407#

Kody będą ważne
Od {{access_code_valid_from}}
Do {{access_code_valid_until}}

Do Państwa dyspozycji pozostają również suszarka na pranie, żelazko, deska do prasowania, a także miotła i mop, znajdują się one w szafie na korytarzu.

Życzymy udanego i komfortowego pobytu!
$market$
        )
) AS template(apartment_name, body)
JOIN apartments AS apartment
    ON apartment.name = template.apartment_name
ON CONFLICT (apartment_id, message_type) DO UPDATE
SET body = EXCLUDED.body,
    attachment_bucket_id = EXCLUDED.attachment_bucket_id,
    attachment_path = EXCLUDED.attachment_path,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

COMMIT;
