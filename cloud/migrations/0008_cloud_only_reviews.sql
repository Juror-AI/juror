-- Juror Cloud no longer exposes a hosted/Action execution-mode choice. Existing repositories
-- are disabled until an administrator explicitly selects them and the worker performs a fresh
-- workflow check. Every hosted settings row is canonicalized to the only supported mode.
UPDATE repository_settings
SET execution_mode = 'cloud',
    action_detected = 0,
    review_enabled = 0,
    qa_enabled = 0,
    qa_security_ready = 0;
