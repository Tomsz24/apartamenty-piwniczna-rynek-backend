BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Polityka ważności kodów jest konfigurowana per apartament. Rezerwacja nadal
-- przechowuje wyłącznie daty pobytu, a ręczne wyjątki zapisujemy przy kodzie.
ALTER TABLE apartments
    ADD COLUMN IF NOT EXISTS access_code_check_in_time time NOT NULL DEFAULT TIME '15:00',
    ADD COLUMN IF NOT EXISTS access_code_check_out_time time NOT NULL DEFAULT TIME '11:00',
    ADD COLUMN IF NOT EXISTS access_code_time_zone text NOT NULL DEFAULT 'Europe/Warsaw';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'apartments_access_code_time_zone_check'
          AND conrelid = 'apartments'::regclass
    ) THEN
        ALTER TABLE apartments
            ADD CONSTRAINT apartments_access_code_time_zone_check
            CHECK (length(trim(access_code_time_zone)) > 0);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS apartment_access_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apartment_id uuid REFERENCES apartments(id) ON DELETE CASCADE,
    provider text NOT NULL DEFAULT 'ttlock',
    provider_device_id bigint NOT NULL,
    scope text NOT NULL,
    display_name text,
    active boolean NOT NULL DEFAULT true,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT apartment_access_devices_provider_check
        CHECK (provider IN ('ttlock')),
    CONSTRAINT apartment_access_devices_scope_check
        CHECK (scope IN ('apartment', 'shared_entrance')),
    CONSTRAINT apartment_access_devices_apartment_scope_check
        CHECK (
            (scope = 'apartment' AND apartment_id IS NOT NULL)
            OR (scope = 'shared_entrance' AND apartment_id IS NULL)
        ),
    CONSTRAINT apartment_access_devices_provider_id_check
        CHECK (provider_device_id > 0),
    CONSTRAINT apartment_access_devices_provider_device_unique
        UNIQUE (provider, provider_device_id)
);

ALTER TABLE apartment_access_devices ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS apartment_access_devices_apartment_idx
    ON apartment_access_devices (apartment_id)
    WHERE apartment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS apartment_access_devices_active_apartment_unique
    ON apartment_access_devices (apartment_id)
    WHERE provider = 'ttlock'
      AND scope = 'apartment'
      AND active = true
      AND apartment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reservation_access_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE RESTRICT,
    access_device_id uuid NOT NULL REFERENCES apartment_access_devices(id) ON DELETE RESTRICT,
    provider text NOT NULL DEFAULT 'ttlock',
    provider_passcode_id bigint,
    code_ciphertext text NOT NULL,
    code_fingerprint text NOT NULL,
    code_name text,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending_create',
    provider_status integer,
    provider_synced_at timestamptz,
    usage_count integer,
    first_used_at timestamptz,
    last_used_at timestamptz,
    usage_synced_at timestamptz,
    last_error text,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    revoked_by text,
    revoked_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT reservation_access_codes_provider_check
        CHECK (provider IN ('ttlock')),
    CONSTRAINT reservation_access_codes_dates_check
        CHECK (valid_until > valid_from),
    CONSTRAINT reservation_access_codes_status_check
        CHECK (
            status IN (
                'pending_create',
                'active',
                'pending_update',
                'pending_delete',
                'revoked',
                'sync_error'
            )
        ),
    CONSTRAINT reservation_access_codes_ciphertext_check
        CHECK (length(code_ciphertext) > 0),
    CONSTRAINT reservation_access_codes_fingerprint_check
        CHECK (code_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT reservation_access_codes_provider_passcode_check
        CHECK (provider_passcode_id IS NULL OR provider_passcode_id > 0),
    CONSTRAINT reservation_access_codes_usage_count_check
        CHECK (usage_count IS NULL OR usage_count >= 0),
    CONSTRAINT reservation_access_codes_version_check
        CHECK (version > 0)
);

ALTER TABLE reservation_access_codes ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS reservation_access_codes_provider_id_unique
    ON reservation_access_codes (provider, provider_passcode_id)
    WHERE provider_passcode_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservation_access_codes_one_current_per_reservation
    ON reservation_access_codes (reservation_id)
    WHERE status <> 'revoked';

CREATE INDEX IF NOT EXISTS reservation_access_codes_reservation_idx
    ON reservation_access_codes (reservation_id);

CREATE INDEX IF NOT EXISTS reservation_access_codes_device_idx
    ON reservation_access_codes (access_device_id);

CREATE INDEX IF NOT EXISTS reservation_access_codes_apartment_history_idx
    ON reservation_access_codes (apartment_id, valid_from DESC, id DESC);

CREATE INDEX IF NOT EXISTS reservation_access_codes_collision_idx
    ON reservation_access_codes (access_device_id, code_fingerprint, valid_from, valid_until)
    WHERE status <> 'revoked';

CREATE TABLE IF NOT EXISTS access_code_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    access_code_id uuid REFERENCES reservation_access_codes(id) ON DELETE CASCADE,
    apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
    access_device_id uuid NOT NULL REFERENCES apartment_access_devices(id) ON DELETE RESTRICT,
    action text NOT NULL,
    code_ciphertext text NOT NULL,
    code_fingerprint text NOT NULL,
    code_name text,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz NOT NULL,
    source_version integer,
    status text NOT NULL DEFAULT 'draft',
    applied_access_code_id uuid REFERENCES reservation_access_codes(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    applied_at timestamptz,
    cancelled_at timestamptz,
    last_error text,
    created_by text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT access_code_drafts_action_check
        CHECK (action IN ('create', 'replace')),
    CONSTRAINT access_code_drafts_action_target_check
        CHECK (
            (action = 'create' AND access_code_id IS NULL AND source_version IS NULL)
            OR (action = 'replace' AND access_code_id IS NOT NULL AND source_version IS NOT NULL)
        ),
    CONSTRAINT access_code_drafts_dates_check
        CHECK (valid_until > valid_from),
    CONSTRAINT access_code_drafts_expiry_check
        CHECK (expires_at > created_at),
    CONSTRAINT access_code_drafts_status_check
        CHECK (status IN ('draft', 'applying', 'applied', 'cancelled', 'sync_error')),
    CONSTRAINT access_code_drafts_ciphertext_check
        CHECK (length(code_ciphertext) > 0),
    CONSTRAINT access_code_drafts_fingerprint_check
        CHECK (code_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT access_code_drafts_version_check
        CHECK (version > 0)
);

ALTER TABLE access_code_drafts ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS access_code_drafts_one_open_per_reservation
    ON access_code_drafts (reservation_id)
    WHERE status IN ('draft', 'applying');

CREATE INDEX IF NOT EXISTS access_code_drafts_reservation_idx
    ON access_code_drafts (reservation_id);

CREATE INDEX IF NOT EXISTS access_code_drafts_apartment_idx
    ON access_code_drafts (apartment_id);

CREATE INDEX IF NOT EXISTS access_code_drafts_device_idx
    ON access_code_drafts (access_device_id);

CREATE INDEX IF NOT EXISTS access_code_drafts_access_code_idx
    ON access_code_drafts (access_code_id)
    WHERE access_code_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS access_code_drafts_applied_code_idx
    ON access_code_drafts (applied_access_code_id)
    WHERE applied_access_code_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS access_code_drafts_device_collision_idx
    ON access_code_drafts (access_device_id, code_fingerprint, valid_from, valid_until)
    WHERE status IN ('draft', 'applying');

CREATE INDEX IF NOT EXISTS access_code_drafts_expiry_idx
    ON access_code_drafts (expires_at)
    WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS access_code_audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    access_code_id uuid NOT NULL REFERENCES reservation_access_codes(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    actor text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT access_code_audit_events_type_check
        CHECK (
            event_type IN (
                'created',
                'create_failed',
                'update_requested',
                'updated',
                'update_failed',
                'delete_requested',
                'revoked',
                'delete_failed'
            )
        )
);

ALTER TABLE access_code_audit_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS access_code_audit_events_code_created_idx
    ON access_code_audit_events (access_code_id, created_at DESC);

-- Kody dostępu nie są częścią publicznego Data API. Dostęp odbywa się wyłącznie
-- przez backend NestJS zabezpieczony SupabaseAdminGuard.
REVOKE ALL ON TABLE apartment_access_devices FROM anon, authenticated;
REVOKE ALL ON TABLE reservation_access_codes FROM anon, authenticated;
REVOKE ALL ON TABLE access_code_drafts FROM anon, authenticated;
REVOKE ALL ON TABLE access_code_audit_events FROM anon, authenticated;

COMMIT;
