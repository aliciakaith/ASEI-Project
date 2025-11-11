-- Flows table
CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  nodes JSONB DEFAULT '[]'::jsonb,
  edges JSONB DEFAULT '[]'::jsonb,
  meta JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_flows_org_id ON flows(org_id);
CREATE INDEX IF NOT EXISTS idx_flows_status ON flows(status);
CREATE INDEX IF NOT EXISTS idx_flows_deleted ON flows(is_deleted);
