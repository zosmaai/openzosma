CREATE TABLE agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  system_prompt TEXT,
  tools_enabled JSONB DEFAULT '[]',
  skills JSONB DEFAULT '[]',
  max_tokens INTEGER DEFAULT 4096,
  temperature REAL DEFAULT 0.7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
