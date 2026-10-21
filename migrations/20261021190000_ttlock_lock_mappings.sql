BEGIN;

-- Apartment locks read from the TTLock account on 2026-10-21 (aliases from the TTLock app):
--   19051854 "Apartament z balkonem i widokiem na góry"   -> Apartament - Widok na góry
--   19051822 "Apartament z kominkiem i widokiem na Rynek" -> Apartament - Widok na rynek
-- The building entrance (19054486) keeps its fixed code from the arrival message
-- template and is deliberately not managed here. Existing rows are never
-- overwritten, so a mapping changed later through the API survives a re-run.
INSERT INTO public.apartment_access_devices (
    apartment_id, provider, provider_device_id, scope, display_name
)
SELECT apartment.id, 'ttlock', lock.lock_id, 'apartment', lock.display_name
FROM (VALUES
    (19051854::bigint, 'Apartament - Widok na góry'::text, 'Apartament z balkonem i widokiem na góry'::text),
    (19051822::bigint, 'Apartament - Widok na rynek'::text, 'Apartament z kominkiem i widokiem na Rynek'::text)
) AS lock(lock_id, apartment_name, display_name)
JOIN public.apartments AS apartment
    ON lower(trim(apartment.name)) = lower(lock.apartment_name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.apartment_access_devices AS existing
    WHERE existing.apartment_id = apartment.id
      AND existing.provider = 'ttlock'
      AND existing.scope = 'apartment'
      AND existing.active = true
)
ON CONFLICT (provider, provider_device_id) DO NOTHING;

COMMIT;
