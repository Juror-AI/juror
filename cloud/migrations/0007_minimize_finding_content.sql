-- Finding rows are the cheap, queryable operational index. Detailed review and QA
-- content lives only in each run's private R2 report and is loaded on demand.
UPDATE finding
SET body = '', claim_json = NULL, expected = NULL, actual = NULL;

UPDATE finding_occurrence
SET details_json = '{}';
