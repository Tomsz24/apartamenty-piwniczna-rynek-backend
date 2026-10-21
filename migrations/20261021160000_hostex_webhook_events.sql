BEGIN;

-- Inbox for Hostex webhooks. Hostex never redelivers a dropped notification and
-- may send duplicates, so every request is stored first (deduplicated by
-- event_id) and processed asynchronously. Only identifiers are kept, never the
-- guest data or the raw payload.
CREATE TABLE IF NOT EXISTS public.hostex_webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key text NOT NULL UNIQUE,
    event_id text,
    event_type text NOT NULL,
    reservation_code text,
    stay_code text,
    property_id bigint,
    payload_keys text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    received_at timestamptz NOT NULL DEFAULT NOW(),
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    processed_at timestamptz,
    CONSTRAINT hostex_webhook_events_status_check
        CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
    CONSTRAINT hostex_webhook_events_type_check CHECK (length(trim(event_type)) > 0),
    CONSTRAINT hostex_webhook_events_attempts_check CHECK (attempts >= 0)
);

ALTER TABLE public.hostex_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hostex_webhook_events FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS hostex_webhook_events_pending_idx
    ON public.hostex_webhook_events (next_attempt_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS hostex_webhook_events_received_idx
    ON public.hostex_webhook_events (received_at DESC);

COMMIT;
