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

-- 6) Real Integrations (marked as error by default - not configured yet)
-- Will become active once user adds API keys or if env vars are set on startup
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO integrations (org_id, name, status, test_url)
SELECT org.org_id, v.name, 'error', v.test_url
FROM org,
     ( VALUES
       ('MTN Mobile Money', 'https://sandbox.momodeveloper.mtn.com'),
       ('Flutterwave', 'https://api.flutterwave.com/v3'),
       ('Airtel Money', 'https://openapiuat.airtel.africa'),
       ('Pesapal', 'https://www.pesapal.com/api')
     ) AS v(name, test_url)
ON CONFLICT (org_id, LOWER(name)) DO NOTHING;

-- 7) Welcome Notification Only
WITH org AS (SELECT id AS org_id FROM organizations WHERE name = 'Demo Org')
INSERT INTO notifications (org_id, type, title, message)
SELECT org.org_id, 'info', 'Welcome', 'Your workspace is ready. Add integrations to get started.'
FROM org;
