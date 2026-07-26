-- FAPOMS Verification SQL Script
-- 1. Check Customer Master Versions & Record Counts
SELECT cmv.id AS version_id, cmv.version_number, cmv.status, COUNT(cr.id) AS total_records
FROM customer_master_versions cmv
LEFT JOIN customer_records cr ON cr.customer_master_version_id = cmv.id
GROUP BY cmv.id, cmv.version_number, cmv.status
ORDER BY cmv.version_number DESC;

-- 2. Check Open Validation Queries per Case
SELECT vq.validation_case_id, COUNT(vq.id) AS open_queries
FROM validation_queries vq
WHERE vq.status = 'OPEN'
GROUP BY vq.validation_case_id;

-- 3. Check Ledger Entry Payouts Integrity
SELECT le.id, le.entry_type, le.amount, le.created_at
FROM ledger_entries le
ORDER BY le.created_at DESC;
