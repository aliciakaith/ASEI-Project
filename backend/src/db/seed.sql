-- === ASEI Demo Seed ===

-- Enable UUID helpers
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Organization
INSERT INTO organizations (name)
VALUES ('Demo Org')
ON CONFLICT (name) DO NOTHING;

-- 2) Default Roles
INSERT INTO roles (name)
VALUES ('admin'), ('developer'), ('viewer')
ON CONFLICT (name) DO NOTHING;

-- 3) Demo User (uses first_name/last_name)
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO users (org_id, email, first_name, last_name, password_hash)
SELECT org.org_id, 'demo@example.com', 'Demo', 'User', 'hashed-password'
FROM org
ON CONFLICT (email) DO NOTHING;

-- 4) Prevent duplicate flows per org
CREATE UNIQUE INDEX IF NOT EXISTS uniq_flows_org_name
  ON flows(org_id, name);

-- 5) Demo Flows (for KPI)
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO flows (id, org_id, name, status)
SELECT gen_random_uuid(), org.org_id, n, 'active'
FROM org, (VALUES
  ('Payments'),
  ('KYC Checks'),
  ('Notifications'),
  ('Reconciler')
) AS t(n)
ON CONFLICT (org_id, name) DO NOTHING;

-- 6) Demo Transactions (for chart + KPIs)
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO tx_events (org_id, success, latency_ms, created_at)
SELECT org.org_id, v.success, v.latency, v.ts
FROM org,
     ( VALUES
       (true,  120, now() - interval '3 hour'),
       (false, 260, now() - interval '2 hour'),
       (true,   95, now() - interval '1 hour'),
       (true,   80, now() - interval '10 minute')
     ) AS v(success, latency, ts);

-- 7) Demo Integration
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO integrations (org_id, name, status)
SELECT org.org_id, 'MTN Mobile Money', 'active'
FROM org
ON CONFLICT DO NOTHING;

-- 8) Demo Notifications
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO notifications (org_id, type, title, message)
SELECT org.org_id, v.type, v.title, v.message
FROM org,
     ( VALUES
       ('info',  'Welcome',         'Your workspace is ready.'),
       ('warn',  'High latency',    'Average latency exceeded 200ms in the last hour.'),
       ('error', 'Sandbox failure', 'Payment to sandbox gateway failed (HTTP 500).')
     ) AS v(type, title, message);
