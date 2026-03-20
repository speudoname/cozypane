CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  username VARCHAR(255) UNIQUE NOT NULL,
  avatar_url TEXT,
  access_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deployments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  app_name VARCHAR(255) NOT NULL,
  subdomain VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) DEFAULT 'building',
  container_id VARCHAR(255),
  project_type VARCHAR(50),
  tier VARCHAR(20) DEFAULT 'small',
  port INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, app_name)
);

CREATE TABLE IF NOT EXISTS domains (
  id SERIAL PRIMARY KEY,
  deployment_id INTEGER REFERENCES deployments(id) ON DELETE CASCADE,
  domain VARCHAR(255) UNIQUE NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_subdomain ON deployments(subdomain);
CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);

-- Admin flag
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- Build logs
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS build_log TEXT;

-- Database provisioning
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS db_name VARCHAR(255);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS db_user VARCHAR(255);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS db_host VARCHAR(255);

-- Deployment groups (for multi-service apps)
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deploy_group VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_deployments_group ON deployments(user_id, deploy_group);

-- Server-side intelligence columns
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS framework VARCHAR(50);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deploy_phase VARCHAR(50);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS error_detail TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS detected_port INTEGER;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS detected_database BOOLEAN DEFAULT FALSE;
