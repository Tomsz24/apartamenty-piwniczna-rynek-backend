BEGIN;

UPDATE apartment_message_templates AS template
SET body = CASE
        WHEN template.body LIKE '%Dodatkowa informacja:%' THEN
            replace(
                template.body,
                E'\n\nDodatkowa informacja:',
                E'\n\nZameldowanie od godziny 15:00.\n\nDodatkowa informacja:'
            )
        ELSE
            replace(
                template.body,
                E'\n\nDo Państwa dyspozycji',
                E'\n\nZameldowanie od godziny 15:00.\n\nDo Państwa dyspozycji'
            )
    END,
    updated_at = NOW()
FROM apartments AS apartment
WHERE template.apartment_id = apartment.id
  AND template.message_type = 'arrival'
  AND apartment.name IN (
      'Apartament - Widok na góry',
      'Apartament - Widok na rynek'
  )
  AND template.body NOT LIKE '%Zameldowanie od godziny 15:00.%';

COMMIT;
