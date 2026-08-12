-- RT117/RT36 Glue-lås, grundschema
-- Tidsstämplar lagras som unix-sekunder (INTEGER) om inget annat anges.

-- Medlemmar. En medlem kan komma från admin-listan eller (senare) tabler.world.
CREATE TABLE members (
  id            TEXT PRIMARY KEY,
  email         TEXT,                                   -- alltid gemener, normaliserad
  phone         TEXT,                                   -- E.164, reserverad för SMS-OTP senare
  name          TEXT,
  club          TEXT,                                   -- 'RT117' | 'RT36' | annat
  role          TEXT NOT NULL DEFAULT 'member',         -- 'member' | 'admin'
  source        TEXT NOT NULL DEFAULT 'admin',          -- 'admin' | 'tablerworld'
  external_id   TEXT,                                   -- medlems-id i tabler.world
  active        INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 1,             -- höjs för att tvinga utloggning
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK (role IN ('member', 'admin')),
  CHECK (source IN ('admin', 'tablerworld'))
);

CREATE UNIQUE INDEX idx_members_email ON members(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_members_phone ON members(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX idx_members_external ON members(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_members_active ON members(active);

-- Engångskoder för e-postinloggning. Koden lagras aldrig i klartext.
CREATE TABLE otp_codes (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,          -- e-postadress i gemener
  code_hash   TEXT NOT NULL,          -- HMAC-SHA256(kod, OTP_PEPPER) i hex
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_otp_identifier ON otp_codes(identifier, created_at);
CREATE INDEX idx_otp_expires ON otp_codes(expires_at);

-- Kortlivat state för Google OAuth (PKCE).
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_oauth_expires ON oauth_states(expires_at);

-- Enkel räknare för hastighetsbegränsning (fast fönster).
CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Revisionslogg. Allt som rör inloggning och upplåsning hamnar här.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  member_id   TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  result      TEXT,                   -- 'ok' | 'denied' | 'error'
  detail      TEXT,                   -- JSON
  ip          TEXT,
  user_agent  TEXT
);

CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_member ON audit_log(member_id, ts DESC);
CREATE INDEX idx_audit_action ON audit_log(action, ts DESC);

-- Upplåsningar mot Glue. Frontenden pollar status via vårt eget id.
CREATE TABLE unlock_operations (
  id                TEXT PRIMARY KEY,
  glue_operation_id TEXT,
  lock_id           TEXT NOT NULL,
  member_id         TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'unlock',   -- 'unlock' | 'lock'
  status            TEXT NOT NULL,                    -- 'pending' | 'completed' | 'timeout' | 'failed'
  reason            TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (type IN ('unlock', 'lock')),
  CHECK (status IN ('pending', 'completed', 'timeout', 'failed'))
);

CREATE INDEX idx_unlock_member ON unlock_operations(member_id, created_at DESC);
CREATE INDEX idx_unlock_created ON unlock_operations(created_at DESC);

-- Nyckel/värde för driftinställningar som admins kan ändra i efterhand.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Nödstopp: sätts till '0' för att stänga av all upplåsning utan att deploya om.
INSERT INTO settings (key, value, updated_at) VALUES ('unlock_enabled', '1', unixepoch());
