BEGIN;

-- Access codes become usable three hours before the advertised 15:00 check-in
-- and remain usable one hour after the 10:00 checkout.
ALTER TABLE apartments
    ALTER COLUMN access_code_check_in_time SET DEFAULT TIME '12:00',
    ALTER COLUMN access_code_check_out_time SET DEFAULT TIME '11:00';

UPDATE apartments
SET access_code_check_in_time = TIME '12:00',
    access_code_check_out_time = TIME '11:00'
WHERE access_code_check_in_time IS DISTINCT FROM TIME '12:00'
   OR access_code_check_out_time IS DISTINCT FROM TIME '11:00';

COMMIT;
