-- Seed demo organization
INSERT INTO organizations (name)
VALUES ('Demo Org')
ON CONFLICT (name) DO NOTHING;

-- Seed default roles
INSERT INTO roles (name)
VALUES 
  ('admin'),
  ('developer'),
  ('viewer')
ON CONFLICT (name) DO NOTHING;

-- Seed demo user in Demo Org
INSERT INTO users (org_id, email, display_name, password_hash)
SELECT id, 'demo@example.com', 'Demo User', 'hashed-password'
FROM organizations
WHERE name = 'Demo Org'
ON CONFLICT (email) DO NOTHING;
