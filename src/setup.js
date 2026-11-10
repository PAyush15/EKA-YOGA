// Additive, idempotent upgrade for existing D1 databases. Old booked durations stay unchanged.
const ready = new WeakMap();
export function ensureSetup(db) {
  if(!ready.has(db))ready.set(db,db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS email_jobs (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id), kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT, last_error TEXT, UNIQUE(booking_id,kind))`),
    db.prepare(`UPDATE courses SET duration_minutes=60 WHERE title='Small Group Yoga' AND duration_minutes=70`)
  ]).catch(e=>{ready.delete(db);throw e;}));
  return ready.get(db);
}
