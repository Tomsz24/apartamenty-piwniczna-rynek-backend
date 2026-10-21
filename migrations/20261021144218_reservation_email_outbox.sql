BEGIN;

CREATE TABLE IF NOT EXISTS public.reservation_email_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('new_reservation','reservation_modified','reservation_cancelled')),
    snapshot jsonb NOT NULL,
    previous_snapshot jsonb,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    request jsonb,
    first_attempt_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    provider_message_id text,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW()
);
ALTER TABLE public.reservation_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_email_outbox FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS reservation_email_outbox_pending_idx
    ON public.reservation_email_outbox (next_attempt_at, created_at) WHERE status='pending';

-- Only business data, never access codes, raw provider payloads or sync timestamps.
CREATE OR REPLACE FUNCTION public.reservation_email_snapshot(data jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
      || jsonb_build_object('apartment_name', (SELECT name FROM public.apartments WHERE id=(data->>'apartment_id')::uuid))
    FROM jsonb_each(data)
    WHERE key = ANY(ARRAY['id','apartment_id','status','start_date','end_date','guest_name',
      'guest_count','adults','children','child_ages','infants','pets','guest_phone',
      'guest_email','total_rate_amount','amount_received','currency','payment_status','note']);
$$;
REVOKE ALL ON FUNCTION public.reservation_email_snapshot(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enqueue_reservation_email()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE current_data jsonb; previous_data jsonb; kind text;
BEGIN
    -- iCal observations and owner blocks are not guest reservations.
    IF NEW.origin NOT IN ('manual', 'hostex', 'booking_email') OR NEW.status='blocked' THEN
        RETURN NEW;
    END IF;
    current_data := public.reservation_email_snapshot(to_jsonb(NEW));
    IF TG_OP='INSERT' THEN
        -- No notifications for imported historical/cancelled stays.
        IF NEW.status='cancelled' OR NEW.end_date < (NOW() AT TIME ZONE 'Europe/Warsaw')::date THEN RETURN NEW; END IF;
        kind := 'new_reservation';
    ELSE
        IF OLD.status='blocked' THEN RETURN NEW; END IF;
        previous_data := public.reservation_email_snapshot(to_jsonb(OLD));
        IF current_data = previous_data THEN RETURN NEW; END IF;
        kind := CASE WHEN NEW.status='cancelled' AND OLD.status<>'cancelled'
                     THEN 'reservation_cancelled' ELSE 'reservation_modified' END;
    END IF;
    INSERT INTO public.reservation_email_outbox(reservation_id,event_type,snapshot,previous_snapshot)
    VALUES(NEW.id,kind,current_data,previous_data);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_reservation_email() FROM PUBLIC;
DROP TRIGGER IF EXISTS reservation_email_changes ON public.reservations;
CREATE TRIGGER reservation_email_changes AFTER INSERT OR UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_reservation_email();

COMMIT;
