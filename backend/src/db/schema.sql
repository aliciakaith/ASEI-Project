-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Organizations ----------
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,  -- 👈 prevents duplicate org names
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email CITEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Roles ----------
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL
);

-- ---------- Pending Users ----------
CREATE TABLE IF NOT EXISTS pending_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,  -- 👈 each email can only be pending once
  first_name TEXT,
  last_name TEXT,
  password_hash TEXT,
  verification_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verification_email_sent_at TIMESTAMPTZ
);

-- ---------- Notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,             -- e.g. 'error', 'info', etc.
  title        TEXT NOT NULL,             -- short summary
  message      TEXT NOT NULL,             -- details or context
  related_id   BIGINT,                    -- optional tx_events.id or flow id
  is_read      BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ---------- Transaction Events ----------
CREATE TABLE IF NOT EXISTS tx_events (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  success      BOOLEAN NOT NULL,
  latency_ms   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tx_events_org_created
  ON tx_events (org_id, created_at DESC);


-- ---------- Integrations ----------
CREATE TABLE IF NOT EXISTS integrations (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'error'
  test_url      TEXT,                               -- probe URL your backend calls
  last_checked  TIMESTAMPTZ,                        -- when verification last ran
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional: avoid duplicate names per org
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_org_name
  ON integrations (org_id, LOWER(name));


CREATE INDEX IF NOT EXISTS idx_notifications_org_created
  ON notifications (org_id, created_at DESC);

-- ---------- Notifications on failed tx_events ----------
CREATE OR REPLACE FUNCTION notify_on_tx_failure() RETURNS trigger AS $$
BEGIN
  IF NEW.success = FALSE THEN
    INSERT INTO notifications (org_id, type, title, message, related_id)
    VALUES (
      NEW.org_id,
      'error',
      'Transaction failed',
      CONCAT('A transaction failed (id=', COALESCE(NEW.id::text, ''), ').'),
      NEW.id
    );
    PERFORM pg_notify('notifications_channel',
                      json_build_object('org_id', NEW.org_id)::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_notify_on_tx_failure ON tx_events;
CREATE TRIGGER trig_notify_on_tx_failure
AFTER INSERT ON tx_events
FOR EACH ROW EXECUTE PROCEDURE notify_on_tx_failure();

-- 🔧 Helpful for dashboard queries
CREATE INDEX IF NOT EXISTS idx_integrations_org_created
  ON integrations (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integrations_org_status
  ON integrations (org_id, status);

-- run these once in psql (or your migration tool)
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS test_url TEXT,
  ADD COLUMN IF NOT EXISTS last_checked TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_integrations_org_created
  ON integrations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrations_org_status
  ON integrations (org_id, status);
