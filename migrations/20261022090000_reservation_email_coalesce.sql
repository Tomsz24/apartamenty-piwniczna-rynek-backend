BEGIN;

-- Coalesce reservation emails. Saving a reservation is often several writes in a
-- row (the app adds a note right after creating it, Hostex zeroes the price of a
-- cancelled stay), which used to send "new" and "modified" seconds apart.
--   * every email waits a short quiet period before it is sent;
--   * changes during that period are folded into the email still waiting
--     (a pending "new" mail simply shows the latest data, a pending "modified"
--     mail keeps its original "before" so the diff covers all changes);
--   * a stay created and cancelled within the quiet period sends nothing;
--   * changes to an already cancelled stay never send "modified".
CREATE OR REPLACE FUNCTION public.enqueue_reservation_email()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    current_data jsonb;
    previous_data jsonb;
    kind text;
    waiting public.reservation_email_outbox;
    quiet_period constant interval := interval '90 seconds';
BEGIN
    -- iCal observations and owner blocks are not guest reservations.
    IF NEW.origin NOT IN ('manual', 'hostex', 'booking_email') OR NEW.status = 'blocked' THEN
        RETURN NEW;
    END IF;
    current_data := public.reservation_email_snapshot(to_jsonb(NEW));
    IF TG_OP = 'INSERT' THEN
        -- No notifications for imported historical/cancelled stays.
        IF NEW.status = 'cancelled' OR NEW.end_date < (NOW() AT TIME ZONE 'Europe/Warsaw')::date THEN
            RETURN NEW;
        END IF;
        kind := 'new_reservation';
    ELSE
        IF OLD.status = 'blocked' OR (OLD.status = 'cancelled' AND NEW.status = 'cancelled') THEN
            RETURN NEW;
        END IF;
        previous_data := public.reservation_email_snapshot(to_jsonb(OLD));
        IF current_data = previous_data THEN RETURN NEW; END IF;
        kind := CASE WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
                     THEN 'reservation_cancelled' ELSE 'reservation_modified' END;

        -- An email for this stay that has not been attempted yet can still change.
        SELECT * INTO waiting
        FROM public.reservation_email_outbox
        WHERE reservation_id = NEW.id
          AND status = 'pending'
          AND first_attempt_at IS NULL
          AND event_type IN ('new_reservation', 'reservation_modified')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE;

        IF FOUND THEN
            IF kind = 'reservation_modified' THEN
                -- The changes were undone before the email went out.
                IF waiting.event_type = 'reservation_modified' AND current_data = waiting.previous_snapshot THEN
                    DELETE FROM public.reservation_email_outbox WHERE id = waiting.id;
                    RETURN NEW;
                END IF;
                UPDATE public.reservation_email_outbox
                SET snapshot = current_data, next_attempt_at = NOW() + quiet_period
                WHERE id = waiting.id;
                RETURN NEW;
            END IF;
            -- Cancelled before anything was sent about it.
            DELETE FROM public.reservation_email_outbox WHERE id = waiting.id;
            IF waiting.event_type = 'new_reservation' THEN RETURN NEW; END IF;
            previous_data := waiting.previous_snapshot;
        END IF;
    END IF;

    INSERT INTO public.reservation_email_outbox (
        reservation_id, event_type, snapshot, previous_snapshot, next_attempt_at
    ) VALUES (NEW.id, kind, current_data, previous_data, NOW() + quiet_period);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_reservation_email() FROM PUBLIC;

COMMIT;
