-- Add missing columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_picture TEXT,
  ADD COLUMN IF NOT EXISTS allow_ip_whitelist BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS rate_limit INTEGER DEFAULT 100;
