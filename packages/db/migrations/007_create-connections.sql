CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('postgresql', 'mysql', 'mongodb', 'clickhouse', 'bigquery', 'sqlite', 'generic_sql')),
  encrypted_credentials TEXT NOT NULL,
  schema_cache JSONB,
  read_only BOOLEAN NOT NULL DEFAULT true,
  query_timeout INTEGER DEFAULT 30,
  row_limit INTEGER DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
