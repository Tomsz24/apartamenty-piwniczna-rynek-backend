BEGIN;

ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS welcome_message_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS arrival_message_sent_at timestamptz;

COMMIT;
