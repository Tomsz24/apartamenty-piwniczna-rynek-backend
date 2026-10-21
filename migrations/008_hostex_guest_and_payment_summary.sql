BEGIN;

ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS infants integer,
    ADD COLUMN IF NOT EXISTS pets integer,
    ADD COLUMN IF NOT EXISTS total_rate_amount numeric(12, 2),
    ADD COLUMN IF NOT EXISTS amount_received numeric(12, 2),
    ADD COLUMN IF NOT EXISTS currency text,
    ADD COLUMN IF NOT EXISTS payment_status text;

ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_infants_check,
    ADD CONSTRAINT reservations_infants_check
        CHECK (infants IS NULL OR infants >= 0),
    DROP CONSTRAINT IF EXISTS reservations_pets_check,
    ADD CONSTRAINT reservations_pets_check
        CHECK (pets IS NULL OR pets >= 0),
    DROP CONSTRAINT IF EXISTS reservations_total_rate_amount_check,
    ADD CONSTRAINT reservations_total_rate_amount_check
        CHECK (total_rate_amount IS NULL OR total_rate_amount >= 0),
    DROP CONSTRAINT IF EXISTS reservations_amount_received_check,
    ADD CONSTRAINT reservations_amount_received_check
        CHECK (amount_received IS NULL OR amount_received >= 0);

COMMIT;
