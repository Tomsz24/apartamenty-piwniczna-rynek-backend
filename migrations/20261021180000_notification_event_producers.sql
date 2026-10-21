BEGIN;

-- New notification kinds produced by the backend.
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
            'system_alert'
        )
    );

-- Hostex message webhooks are linked to a conversation, not a reservation.
ALTER TABLE public.hostex_webhook_events
    ADD COLUMN IF NOT EXISTS conversation_id text;

-- Short human-readable stay description used in notification bodies.
CREATE OR REPLACE FUNCTION public.notification_stay_label(reservation public.reservations)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT concat_ws(' · ',
        (SELECT name FROM public.apartments WHERE id = reservation.apartment_id),
        NULLIF(trim(reservation.guest_name), ''),
        to_char(reservation.start_date, 'DD.MM') || '–' || to_char(reservation.end_date, 'DD.MM.YYYY')
    );
$$;
REVOKE ALL ON FUNCTION public.notification_stay_label(public.reservations) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enqueue_reservation_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    kind text;
    title text;
    priority text := 'normal';
    dedupe text;
    today date := (NOW() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
    -- Guest stays only: iCal observations and owner blocks are not reservations.
    IF NEW.origin NOT IN ('manual', 'hostex', 'booking_email') OR NEW.status = 'blocked' THEN
        RETURN NEW;
    END IF;
    -- Imported history never notifies.
    IF NEW.end_date < today THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
        kind := 'new_reservation';
        title := 'Nowa rezerwacja';
        dedupe := 'reservation:' || NEW.id || ':new';
    ELSE
        IF OLD.status = 'blocked' THEN RETURN NEW; END IF;
        IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
            kind := 'reservation_cancelled';
            title := 'Rezerwacja anulowana';
            priority := 'high';
            dedupe := 'reservation:' || NEW.id || ':cancelled';
        ELSIF NEW.status <> 'cancelled' AND (
            NEW.status IS DISTINCT FROM OLD.status
            OR NEW.start_date IS DISTINCT FROM OLD.start_date
            OR NEW.end_date IS DISTINCT FROM OLD.end_date
            OR NEW.apartment_id IS DISTINCT FROM OLD.apartment_id
            OR NEW.guest_count IS DISTINCT FROM OLD.guest_count
            OR NEW.guest_name IS DISTINCT FROM OLD.guest_name
        ) THEN
            kind := 'reservation_modified';
            title := 'Zmiana rezerwacji';
            -- One event per distinct resulting state, so repeated syncs do not repeat it.
            dedupe := 'reservation:' || NEW.id || ':modified:' || md5(concat_ws('|',
                NEW.status, NEW.start_date, NEW.end_date, NEW.apartment_id,
                NEW.guest_count, NEW.guest_name));
        ELSE
            RETURN NEW;
        END IF;
    END IF;

    -- A notification must never block a reservation write.
    BEGIN
        INSERT INTO public.notification_events (
            dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
        ) VALUES (
            dedupe, kind, priority, NEW.apartment_id, NEW.id, title,
            public.notification_stay_label(NEW),
            jsonb_build_object('reservationId', NEW.id)
        )
        ON CONFLICT (dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'notification for reservation % skipped: %', NEW.id, SQLERRM;
    END;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_reservation_notification() FROM PUBLIC;

DROP TRIGGER IF EXISTS reservation_notification_changes ON public.reservations;
CREATE TRIGGER reservation_notification_changes AFTER INSERT OR UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_reservation_notification();

CREATE OR REPLACE FUNCTION public.enqueue_access_code_error_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    stay public.reservations;
BEGIN
    IF NEW.status <> 'sync_error' OR (TG_OP = 'UPDATE' AND OLD.status = 'sync_error') THEN
        RETURN NEW;
    END IF;
    BEGIN
        SELECT * INTO stay FROM public.reservations WHERE id = NEW.reservation_id;
        INSERT INTO public.notification_events (
            dedupe_key, event_type, priority, apartment_id, reservation_id, title, body, payload
        ) VALUES (
            'access_code_error:' || NEW.id || ':' || extract(epoch FROM NEW.updated_at)::bigint,
            'access_code_error', 'critical', NEW.apartment_id, NEW.reservation_id,
            'Błąd kodu do drzwi',
            COALESCE(public.notification_stay_label(stay), 'Sprawdź kod w aplikacji'),
            jsonb_build_object('reservationId', NEW.reservation_id, 'accessCodeId', NEW.id)
        )
        ON CONFLICT (dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'access code notification % skipped: %', NEW.id, SQLERRM;
    END;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_access_code_error_notification() FROM PUBLIC;

DROP TRIGGER IF EXISTS access_code_error_notification ON public.reservation_access_codes;
CREATE TRIGGER access_code_error_notification
    AFTER INSERT OR UPDATE OF status ON public.reservation_access_codes
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_access_code_error_notification();

-- Stuck "processing" events are found by this index after a crash.
CREATE INDEX IF NOT EXISTS notification_events_processing_idx
    ON public.notification_events (updated_at)
    WHERE status = 'processing';

COMMIT;
