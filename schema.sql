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


CREATE TABLE IF NOT EXISTS payments (booking_id TEXT PRIMARY KEY REFERENCES bookings(id), paid_at TEXT NOT NULL);
INSERT INTO courses (title,description,duration_minutes,capacity,price_cents,currency) SELECT 'Private yoga (1 : 1)','Personalized class according to your medical condition, chronic pain or other health concern with suitable poses and modifications to support your comfort and abilities.',60,1,8000,'USD' WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title='Private yoga (1 : 1)');
INSERT INTO courses (title,description,duration_minutes,capacity,price_cents,currency) SELECT 'Small Group Yoga','Practice yoga together while receiving the personal attention you deserve. I’ll guide you with modifications to suit each person’s needs and goals. (Maximum 5 people)',60,5,5000,'USD' WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title='Small Group Yoga');
INSERT INTO courses (title,description,duration_minutes,capacity,price_cents,currency) SELECT 'Foundation Class','In this class, Each pose will explain and demonstrated in detail, with a focus on proper alignment, breathing techniques, and step-by-step guidance. so you can get much benefits and avoid mistakes. (Everyone is welcome)',60,1,10000,'USD' WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title='Foundation Class');
INSERT INTO courses (title,description,duration_minutes,capacity,price_cents,currency) SELECT 'Group Yoga Session','Exercises for all over body. Bring your mat, Room temperature water bottle, Towel, Comfy cloths and most importantly, Bring yourself. (10 people Max)',70,10,8500,'USD' WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title='Group Yoga Session');
INSERT INTO courses (title,description,duration_minutes,capacity,price_cents,currency) SELECT 'Office Workers session','Designed especially for office workers, these sessions focus on desk-related stiffness, neck and shoulder tension, posture, and stress relief. (4 people max)',60,4,5000,'USD' WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title='Office Workers session');


-- Customer accounts are keyed by Google's immutable subject, never a typed email.
-- Additive and safe to re-run against an existing booking database.
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_sessions_expiry ON customer_sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_challenges (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_expiry ON login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS customer_bookings (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_bookings_owner ON customer_bookings(customer_id);

-- Durable delivery records; no copied customer data or secrets.
CREATE TABLE IF NOT EXISTS email_jobs (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error TEXT,
  UNIQUE(booking_id,kind)
);
