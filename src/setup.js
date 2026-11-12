// Additive, idempotent upgrade for existing D1 databases. Old booked durations stay unchanged.
const ready = new WeakMap();
export function ensureSetup(db) {
  if(!ready.has(db))ready.set(db,db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS payments (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id), paid_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS booking_addresses (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
      address_line1 TEXT NOT NULL, address_line2 TEXT NOT NULL DEFAULT '',
      address_city TEXT NOT NULL, address_state TEXT NOT NULL, address_zip TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_jobs (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id), kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT, last_error TEXT, UNIQUE(booking_id,kind))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES email_jobs(id), recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER,
  provider_id TEXT UNIQUE, accepted_at TEXT, last_error TEXT, payload TEXT,
  UNIQUE(job_id,recipient))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS email_events_provider ON email_events(provider_id,occurred_at)`),
    db.prepare(`UPDATE courses SET duration_minutes=60 WHERE title='Small Group Yoga' AND duration_minutes=70`)
  ]).catch(e=>{ready.delete(db);throw e;}));
  return ready.get(db);
}

