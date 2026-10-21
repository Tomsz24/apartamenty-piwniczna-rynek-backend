BEGIN;

CREATE INDEX IF NOT EXISTS orphaned_reservation_notes_attached_reservation_idx
    ON orphaned_reservation_notes (attached_to_reservation_id);

COMMIT;
