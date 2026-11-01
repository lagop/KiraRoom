-- The add-ons of the appointments that can still change get what they were
-- booked at: each line of appointments.addons gains the name, price (EUROS,
-- like services.price) and duration of its service, as the application
-- writes them since 20261102040000_appointment_service_snapshot
-- (snapshotAddons in src/appointments/appointment-snapshot.ts).
--
-- That migration filled the snapshot of each appointment and of its service
-- rows, but not of its add-ons: their lines kept only {addonId, quantity}, so
-- the till, the invoice and an edit of the visit still read the add-on's
-- price from today's catalog, and a price change reached appointments
-- already booked. Without a snapshot a line falls back to the live service
-- (bookedAddon), so this only fixes the figures as they are now.
--
-- Which appointments: the same as 20261102040000 -- still to happen (from
-- yesterday on, so no timezone is missed) or not paid yet, and not cancelled
-- or no-show. History (paid and in the past) keeps its lines as they are.
--
-- Which lines: an object naming one of THE SAME SALON's services (addonId,
-- or serviceId as older rows have it) without a usable price. A line that
-- already has a price keeps it and its name and duration; a line naming no
-- service of the salon (deleted, another salon's, malformed) is left as it is
-- and keeps falling back as before. The other lines and their order stay.
-- The stored shapes the reader accepts (normalizeAddons) are all read: a
-- plain list (with one level of nested lists), {"set": [...]} and an
-- {addonId: quantity} map; an appointment whose lines change is written back
-- as the plain list the application writes.
--
-- In batches of 2000 appointments by primary key (a keyset over "id", so
-- every row is visited once and the loop always ends, even over lines that
-- cannot be filled), each batch one UPDATE of only the rows that change.
-- Idempotent: a line with a price is never touched again, so running this
-- block again (by hand, after a partial run) finishes the job and changes
-- nothing that is done. One statement (a DO block), so it can be re-run as is.
DO $$
DECLARE
  from_id text := '';
  upto text;
BEGIN
  LOOP
    SELECT max(b."id") INTO upto
    FROM (
      SELECT a."id"
      FROM "appointments" a
      WHERE a."id" > from_id
        AND a."addons" NOT IN ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
        AND a."status" NOT IN ('cancelled', 'no_show')
        AND (
          a."scheduledDate" >= (CURRENT_DATE - 1)
          OR a."paymentStatus" IN ('pending', 'failed')
        )
      ORDER BY a."id"
      LIMIT 2000
    ) b;
    EXIT WHEN upto IS NULL;

    WITH open AS (
      SELECT
        a."id",
        a."tenantId",
        CASE
          WHEN jsonb_typeof(a."addons") = 'array' THEN a."addons"
          WHEN jsonb_typeof(a."addons") = 'object' AND jsonb_typeof(a."addons" -> 'set') = 'array'
            THEN a."addons" -> 'set'
          WHEN jsonb_typeof(a."addons") = 'object' THEN (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('addonId', m.key, 'quantity', m.value)), '[]'::jsonb)
            FROM jsonb_each(a."addons") AS m(key, value)
          )
          ELSE '[]'::jsonb
        END AS lines
      FROM "appointments" a
      WHERE a."id" > from_id
        AND a."id" <= upto
        AND a."addons" NOT IN ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
        AND a."status" NOT IN ('cancelled', 'no_show')
        AND (
          a."scheduledDate" >= (CURRENT_DATE - 1)
          OR a."paymentStatus" IN ('pending', 'failed')
        )
    ),
    -- One row per line, in order; a nested list counts as its lines.
    items AS (
      SELECT
        o."id",
        o."tenantId",
        e.ord * 100000 + COALESCE(n.ord, 0) AS ord,
        COALESCE(n.item, e.item) AS item
      FROM open o
      CROSS JOIN LATERAL jsonb_array_elements(o.lines) WITH ORDINALITY AS e(item, ord)
      LEFT JOIN LATERAL (
        SELECT x.item, x.ord
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.item) = 'array' THEN e.item ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS x(item, ord)
      ) n ON TRUE
    ),
    marked AS (
      SELECT
        i.*,
        -- A line object without a usable price: none, null, or not a number
        -- (a missing key types as NULL, hence the COALESCE).
        COALESCE(jsonb_typeof(i.item) = 'object', FALSE)
          AND NOT COALESCE(
            jsonb_typeof(i.item -> 'price') = 'number'
            OR (
              jsonb_typeof(i.item -> 'price') = 'string'
              AND btrim(i.item ->> 'price') ~ '^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$'
            ),
            FALSE
          ) AS unpriced
      FROM items i
    ),
    filled AS (
      SELECT
        m."id",
        m.ord,
        (m.unpriced AND s."id" IS NOT NULL) AS changed,
        CASE
          WHEN m.unpriced AND s."id" IS NOT NULL THEN
            m.item
            || jsonb_build_object(
                 'price', to_jsonb(s."price"::double precision),
                 'duration', to_jsonb(COALESCE(s."duration", 0))
               )
            || CASE
                 WHEN COALESCE(s."name", '') <> '' THEN jsonb_build_object('name', s."name")
                 ELSE '{}'::jsonb
               END
          ELSE m.item
        END AS item
      FROM marked m
      LEFT JOIN "services" s
        ON m.unpriced
       AND s."tenantId" = m."tenantId"
       AND s."id" = COALESCE(m.item ->> 'addonId', m.item ->> 'serviceId')
    ),
    rebuilt AS (
      SELECT f."id", jsonb_agg(f.item ORDER BY f.ord) AS addons
      FROM filled f
      GROUP BY f."id"
      HAVING bool_or(f.changed)
    )
    UPDATE "appointments" AS a
    SET "addons" = r.addons
    FROM rebuilt r
    WHERE a."id" = r."id";

    from_id := upto;
  END LOOP;
END $$;
