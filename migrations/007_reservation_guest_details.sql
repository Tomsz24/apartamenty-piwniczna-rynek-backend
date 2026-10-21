BEGIN;

ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS guest_phone text,
    ADD COLUMN IF NOT EXISTS guest_email text,
    ADD COLUMN IF NOT EXISTS child_ages smallint[];

ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_child_ages_check;

ALTER TABLE reservations
    ADD CONSTRAINT reservations_child_ages_check
    CHECK (
        child_ages IS NULL OR (
            cardinality(child_ages) <= 50
            AND 0 <= ALL(child_ages)
            AND 17 >= ALL(child_ages)
        )
    );

COMMIT;
