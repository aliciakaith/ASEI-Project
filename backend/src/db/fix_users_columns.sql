-- Add missing columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_picture TEXT,
  ADD COLUMN IF NOT EXISTS allow_ip_whitelist BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS rate_limit INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS send_error_alerts BOOLEAN DEFAULT true;

-- Create api_rate_tracking table for rate limiting middleware
CREATE TABLE IF NOT EXISTS api_rate_tracking (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  ip_address VARCHAR(100),
  timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);
