-- Ansökningar från icke-medlemmar, datumgiltighet för medlemmar (uthyrning)
-- och möjlighet för admins att slippa ansökningsmejl. tabler.world-stödet är
-- borttaget ur koden; kolumnerna source/external_id lämnas kvar i schemat men
-- alla rader märks som 'admin'.

ALTER TABLE members ADD COLUMN valid_from INTEGER;            -- unix-sekunder, NULL betyder ingen startgräns
ALTER TABLE members ADD COLUMN valid_until INTEGER;           -- unix-sekunder, NULL betyder ingen slutgräns
ALTER TABLE members ADD COLUMN notify_applications INTEGER NOT NULL DEFAULT 1;  -- admin får mejl vid ny ansökan

UPDATE members SET source = 'admin' WHERE source = 'tablerworld';

-- Ansökningar om åtkomst. E-postadressen är alltid verifierad (Google eller
-- engångskod) innan raden skapas. Högst en väntande ansökan per adress.
CREATE TABLE applications (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,                    -- gemener, normaliserad
  name        TEXT NOT NULL,
  club        TEXT NOT NULL,                    -- vald klubb, eller fritext vid "Annan"
  message     TEXT,
  via         TEXT NOT NULL,                    -- 'google' eller 'otp', hur adressen verifierades
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'approved' eller 'rejected'
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT,                             -- adminens medlems-id
  ip          TEXT,
  user_agent  TEXT,
  CHECK (via IN ('google', 'otp')),
  CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX idx_applications_pending ON applications(email) WHERE status = 'pending';
CREATE INDEX idx_applications_status ON applications(status, created_at DESC);
