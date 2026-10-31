-- QueueBridge — Append-Only Enforcement for queue_events
-- Migration: 0002_append_only_trigger
-- Idempotent: CREATE OR REPLACE for function, DROP/CREATE for trigger

-- ---------------------------------------------------------------------------
-- Function: reject any UPDATE or DELETE on queue_events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_queue_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'queue_events is append-only. UPDATE and DELETE are not permitted. '
    'Attempted operation: %. '
    'This is an architectural invariant of QueueBridge (ADR-010).',
    TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Trigger: fire BEFORE UPDATE OR DELETE on queue_events
-- ---------------------------------------------------------------------------

-- Drop first so re-running the migration is idempotent
DROP TRIGGER IF EXISTS queue_events_append_only ON queue_events;

CREATE TRIGGER queue_events_append_only
  BEFORE UPDATE OR DELETE ON queue_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_queue_event_mutation();
