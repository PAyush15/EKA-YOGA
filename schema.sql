-- Run once on a NEW database. All dates stored as ISO-8601 UTC.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Yoga',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 360),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity_override INTEGER CHECK (capacity_override BETWEEN 1 AND 200),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_upcoming ON sessions (starts_at, course_id);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_session_status ON bookings (session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_email_per_session
  ON bookings (session_id, lower(email)) WHERE status = 'confirmed';
