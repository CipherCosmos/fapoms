-- Grant the gold-audit skills and certification to every active assayer that lacks them.
--
-- HOW TO RUN (on the homeserver):
--   podman exec -i fapoms-postgres psql -U fapoms -d fapoms \
--     < ~/apps/fapoms/packages/backend/scripts/sql/grant-gold-audit-attributes.sql
--
-- It prints a verification count at the end: active_assayers should equal fully_qualified.
--
-- Why: the gold-audit projects require skills "Gold" + "Gold Valuation" and the certification
-- "Gold Valuation Specialist". Only 1 of 26 active assayers had them recorded, so every branch
-- of those projects could only ever match that one person, whatever the distance. The engine was
-- right; the roster was never filled in.
--
-- Safe to run more than once: each insert is guarded by NOT EXISTS on (assayer, type, name), so a
-- second run adds nothing. Only assayers who are active AND status='ACTIVE' are touched.
--
-- `created_by` is stamped so these rows are distinguishable from hand-entered ones later.

BEGIN;

-- Two skills.
INSERT INTO workforce_attributes (assayer_id, type, name, is_active, version, created_by, created_at, updated_at)
SELECT a.id, 'SKILL', s.name, true, 1, 'bulk-grant:gold-audit', now(), now()
FROM assayers a
CROSS JOIN (VALUES ('Gold'), ('Gold Valuation')) AS s(name)
WHERE a.is_active AND a.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM workforce_attributes w
    WHERE w.assayer_id = a.id AND w.is_active
      AND w.type = 'SKILL' AND lower(w.name) = lower(s.name)
  );

-- The certification. Expiry mirrors the existing records (2028-12-31); the eligibility gate
-- rejects a lapsed certification, so a NULL expiry would pass today and behave differently from
-- every other row on the table.
INSERT INTO workforce_attributes (assayer_id, type, name, expiry_date, is_active, version, created_by, created_at, updated_at)
SELECT a.id, 'CERTIFICATION', 'Gold Valuation Specialist', TIMESTAMPTZ '2028-12-31 00:00:00+00',
       true, 1, 'bulk-grant:gold-audit', now(), now()
FROM assayers a
WHERE a.is_active AND a.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM workforce_attributes w
    WHERE w.assayer_id = a.id AND w.is_active
      AND w.type = 'CERTIFICATION' AND lower(w.name) = 'gold valuation specialist'
  );

COMMIT;

-- Verification: every active assayer should now read t / t / t.
SELECT count(*) AS active_assayers,
       count(*) FILTER (WHERE gold AND gold_val AND cert_ok) AS fully_qualified
FROM (
  SELECT a.id,
         bool_or(w.type='SKILL' AND lower(w.name)='gold') AS gold,
         bool_or(w.type='SKILL' AND lower(w.name)='gold valuation') AS gold_val,
         bool_or(w.type='CERTIFICATION' AND lower(w.name)='gold valuation specialist'
                 AND (w.expiry_date IS NULL OR w.expiry_date > now())) AS cert_ok
  FROM assayers a LEFT JOIN workforce_attributes w ON w.assayer_id = a.id AND w.is_active
  WHERE a.is_active AND a.status = 'ACTIVE'
  GROUP BY a.id
) t;
