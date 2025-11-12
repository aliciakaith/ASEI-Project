-- Flow Execution Tables
-- Tracks actual flow runs and their results

-- ---------- Flow Executions ----------
CREATE TABLE IF NOT EXISTS flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_version INTEGER NOT NULL,  -- which version of the flow was executed
  status TEXT NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed', 'cancelled'
  trigger_type TEXT NOT NULL,  -- 'manual', 'webhook', 'schedule', 'deploy'
  trigger_data JSONB,  -- webhook payload, schedule info, etc.
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  execution_time_ms INTEGER,
  CONSTRAINT fk_flow_version FOREIGN KEY (flow_id, flow_version) 
    REFERENCES flow_versions(flow_id, version) ON DELETE CASCADE
);

-- ---------- Execution Steps ----------
-- Tracks each node execution within a flow run
CREATE TABLE IF NOT EXISTS execution_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES flow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,  -- matches node.id from graph
  node_type TEXT NOT NULL,  -- trigger, action, condition, etc.
  node_kind TEXT,  -- http, salesforce, transform, etc.
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed', 'skipped'
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_data JSONB,  -- data received by this node
  output_data JSONB,  -- data produced by this node
  error_message TEXT,
  execution_time_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  CONSTRAINT execution_steps_execution_id_node_id_key UNIQUE (execution_id, node_id)
);

-- ---------- Execution Logs ----------
-- Detailed logs for debugging
CREATE TABLE IF NOT EXISTS execution_logs (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES flow_executions(id) ON DELETE CASCADE,
  step_id UUID REFERENCES execution_steps(id) ON DELETE CASCADE,
  level TEXT NOT NULL,  -- 'info', 'warn', 'error', 'debug'
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_flow_executions_flow_id 
  ON flow_executions(flow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_executions_status 
  ON flow_executions(status);

CREATE INDEX IF NOT EXISTS idx_execution_steps_execution_id 
  ON execution_steps(execution_id);

CREATE INDEX IF NOT EXISTS idx_execution_logs_execution_id 
  ON execution_logs(execution_id, created_at);

-- ---------- Flow Triggers ----------
-- Stores trigger configurations for flows
CREATE TABLE IF NOT EXISTS flow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'webhook', 'schedule', 'manual'
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL,  -- webhook URL, cron expression, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_triggers_flow_id 
  ON flow_triggers(flow_id);

CREATE INDEX IF NOT EXISTS idx_flow_triggers_type_enabled 
  ON flow_triggers(type, enabled) WHERE enabled = true;
