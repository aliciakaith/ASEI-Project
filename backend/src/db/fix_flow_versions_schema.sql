-- Fix flow_versions schema to match code expectations
-- Drop dependent tables first (cascade), then recreate with correct schema

-- Drop tables in order (dependent first)
DROP TABLE IF EXISTS execution_logs CASCADE;
DROP TABLE IF EXISTS execution_steps CASCADE;
DROP TABLE IF EXISTS flow_executions CASCADE;
DROP TABLE IF EXISTS flow_triggers CASCADE;
DROP TABLE IF EXISTS flow_versions CASCADE;

-- Recreate flow_versions with correct schema
CREATE TABLE IF NOT EXISTS flow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph JSONB DEFAULT '{}'::jsonb,
  variables JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  UNIQUE(flow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_id ON flow_versions(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_versions_created_at ON flow_versions(created_at);

-- Recreate flow_executions with correct foreign key
CREATE TABLE IF NOT EXISTS flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_type TEXT NOT NULL,
  trigger_data JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  execution_time_ms INTEGER,
  CONSTRAINT fk_flow_version FOREIGN KEY (flow_id, flow_version) 
    REFERENCES flow_versions(flow_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flow_executions_flow_id 
  ON flow_executions(flow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_executions_status 
  ON flow_executions(status);

-- Recreate execution_steps
CREATE TABLE IF NOT EXISTS execution_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES flow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_kind TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_data JSONB,
  output_data JSONB,
  error_message TEXT,
  execution_time_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  CONSTRAINT execution_steps_execution_id_node_id_key UNIQUE (execution_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_steps_execution_id 
  ON execution_steps(execution_id);

-- Recreate execution_logs
CREATE TABLE IF NOT EXISTS execution_logs (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES flow_executions(id) ON DELETE CASCADE,
  step_id UUID REFERENCES execution_steps(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_execution_id 
  ON execution_logs(execution_id, created_at);

-- Recreate flow_triggers
CREATE TABLE IF NOT EXISTS flow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_triggers_flow_id 
  ON flow_triggers(flow_id);

CREATE INDEX IF NOT EXISTS idx_flow_triggers_type_enabled 
  ON flow_triggers(type, enabled) WHERE enabled = true;
