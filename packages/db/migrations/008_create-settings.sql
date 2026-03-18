CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default settings
INSERT INTO settings (key, value) VALUES
  ('instance_name', '"OpenZosma"'),
  ('sandbox_pool_size', '2'),
  ('max_concurrent_sessions', '10'),
  ('max_session_duration_seconds', '3600'),
  ('max_turns_per_session', '100');
