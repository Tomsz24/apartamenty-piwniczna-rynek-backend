BEGIN;

-- All data access goes through the backend (database role `postgres`). The
-- Supabase Data API roles keep only the default grants Supabase adds to new
-- tables; RLS without policies already hides every row, so revoking them
-- changes no behaviour and removes privileges RLS does not cover (TRUNCATE).
DO $$
DECLARE table_record record;
BEGIN
    FOR table_record IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format(
            'REVOKE ALL ON TABLE public.%I FROM anon, authenticated',
            table_record.tablename
        );
    END LOOP;
END;
$$;

-- Tables created later by the migrations (run as `postgres`) start without
-- Data API grants as well.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;

COMMIT;
