// Cloudflare Worker: same-origin static site + JSON booking API + D1.
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
  });

const INVALID = (message, status = 400) => json({ error: message }, status);
const courseSelect = `SELECT id, title, description, category, duration_minutes, capacity,
  price_cents, currency, active FROM courses`;
const sessionSelect = `SELECT s.id, s.course_id, s.starts_at, s.ends_at, s.cancelled,
  c.title AS course_title, c.category, c.duration_minutes, c.price_cents, c.currency,
  COALESCE(s.capacity_override, c.capacity) AS capacity,
  (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'confirmed') AS reserved
  FROM sessions s JOIN courses c ON c.id = s.course_id`;

function safeString(value, max = 100) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function cleanEmail(value) { const email = safeString(value, 200).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''; }
function adminOK(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const [user, pass] = atob(auth.slice(6)).split(':');
    return !!env.ADMIN_USERNAME && !!env.ADMIN_PASSWORD && user === env.ADMIN_USERNAME && pass === env.ADMIN_PASSWORD;
  } catch { return false; }
}
function demandAdmin() {
  return json({ error: 'Administrator login required.' }, 401, { 'WWW-Authenticate': 'Basic realm="Yoga Studio Admin", charset="UTF-8"' });
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
async function parseJSON(request) {
  if (Number(request.headers.get('content-length') || 0) > 8192) throw new Error('Payload too large.');
  const value = await request.text();
  if (value.length > 8192) throw new Error('Payload too large.');
  return JSON.parse(value);
}
function validISO(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }

async function notify(env, booking) {
  if (!env.NOTIFY_WEBHOOK_URL || !env.NOTIFY_SHARED_SECRET) return;
  try {
    const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: env.NOTIFY_SHARED_SECRET, studioName: env.STUDIO_NAME || 'Yoga Studio',
        studioTimezone: env.STUDIO_TIMEZONE || 'Europe/Berlin', ...booking })
    });
    if (!res.ok) console.error('Email notification webhook error', res.status);
  } catch (error) { console.error('Email notification failed', String(error)); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/admin/') return Response.redirect(new URL('/admin', request.url), 302);
      if (path === '/admin') {
        if (!adminOK(request, env)) return demandAdmin();
        const file = new URL('/admin.html', request.url);
        const response = await env.ASSETS.fetch(new Request(file));
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-frame-options', 'DENY');
        return new Response(response.body, { status: response.status, headers });
      }
      if (path === '/admin.html') return Response.redirect(new URL('/admin', request.url), 302);
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (!env.DB) return INVALID('Database not configured.', 503);

      if (request.method === 'GET' && path === '/api/config')
        return json({ studioName: env.STUDIO_NAME || 'Yoga Studio', timezone: env.STUDIO_TIMEZONE || 'Europe/Berlin' });

      if (request.method === 'GET' && path === '/api/courses') {
        const { results } = await env.DB.prepare(`${courseSelect} WHERE active = 1 ORDER BY id`).all();
        return json({ courses: results });
      }

      if (request.method === 'GET' && path === '/api/sessions') {
        const start = safeString(url.searchParams.get('start'), 30);
        const end = safeString(url.searchParams.get('end'), 30);
        const from = validISO(start) ? start : new Date().toISOString();
        const until = validISO(end) && Date.parse(end) - Date.parse(from) <= 100 * 86400000
          ? end : new Date(Date.parse(from) + 65 * 86400000).toISOString();
        const { results } = await env.DB.prepare(`${sessionSelect}
          WHERE c.active=1 AND s.cancelled=0 AND s.starts_at >= ? AND s.starts_at <= ?
          ORDER BY s.starts_at LIMIT 1000`).bind(from, until).all();
        return json({ sessions: results.map(r => ({ ...r, remaining: Math.max(0, r.capacity - r.reserved) })) });
      }

      if (request.method === 'POST' && path === '/api/bookings') {
        if (!sameOrigin(request)) return INVALID('Invalid request origin.', 403);
        const data = await parseJSON(request);
        const id = Number(data.session_id);
        const first = safeString(data.first_name, 70);
        const last = safeString(data.last_name, 70);
        const email = cleanEmail(data.email);
        const phone = safeString(data.phone, 50);
        const website = safeString(data.website, 200); // honeypot field: must remain empty
        if (website) return INVALID('Unable to create booking.', 400);
        if (!Number.isSafeInteger(id) || id < 1 || !first || !last || !email) return INVALID('Enter valid name, email and class.', 400);
        const bookingId = crypto.randomUUID();
        let result;
        try {
          // Single conditional INSERT enforces class capacity atomically in D1.
          result = await env.DB.prepare(`INSERT INTO bookings
              (id, session_id, first_name, last_name, email, phone)
            SELECT ?, s.id, ?, ?, ?, ? FROM sessions s
            JOIN courses c ON c.id = s.course_id
            WHERE s.id = ? AND s.cancelled = 0 AND c.active = 1
              AND s.starts_at > ?
              AND (SELECT COUNT(*) FROM bookings b WHERE b.session_id = s.id
                   AND b.status = 'confirmed') < COALESCE(s.capacity_override, c.capacity)`)
            .bind(bookingId, first, last, email, phone, id, new Date().toISOString()).run();
        } catch (error) {
          if (String(error).includes('UNIQUE constraint')) return INVALID('This email is already registered for that class.', 409);
          throw error;
        }
        if (!result.meta?.changes) return INVALID('This class is full, unavailable or has already started.', 409);
        const row = await env.DB.prepare(`${sessionSelect} WHERE s.id = ?`).bind(id).first();
        const notification = { id: bookingId, firstName: first, lastName: last, email, phone,
          course: row.course_title, startsAt: row.starts_at, endsAt: row.ends_at,
          remaining: Math.max(0, row.capacity - row.reserved), origin: url.origin };
        ctx.waitUntil(notify(env, notification));
        return json({ id: bookingId, course: row.course_title, starts_at: row.starts_at,
          ends_at: row.ends_at, email, remaining: notification.remaining }, 201);
      }

      // Everything below requires administrator HTTP Basic authentication.
      if (path.startsWith('/api/admin/')) {
        if (!adminOK(request, env)) return demandAdmin();
        if (request.method !== 'GET' && !sameOrigin(request)) return INVALID('Invalid request origin.', 403);
        if (request.method === 'GET' && path === '/api/admin/overview') {
          const [courses, sessions, bookings] = await Promise.all([
            env.DB.prepare(`${courseSelect} ORDER BY id DESC`).all(),
            env.DB.prepare(`${sessionSelect} WHERE s.starts_at >= ? ORDER BY s.starts_at LIMIT 200`).bind(new Date().toISOString()).all(),
            env.DB.prepare(`SELECT b.id, b.session_id, b.first_name, b.last_name, b.email, b.phone, b.status,
              b.created_at, s.starts_at, c.title AS course_title
              FROM bookings b JOIN sessions s ON s.id=b.session_id
              JOIN courses c ON c.id=s.course_id ORDER BY b.created_at DESC LIMIT 300`).all()
          ]);
          return json({ courses: courses.results, sessions: sessions.results,
            bookings: bookings.results });
        }
        if (request.method === 'POST' && path === '/api/admin/courses') {
          const d = await parseJSON(request);
          const title = safeString(d.title, 120);
          const description = safeString(d.description, 1000);
          const category = safeString(d.category, 45) || 'Yoga';
          const duration = Number(d.duration_minutes);
          const capacity = Number(d.capacity);
          const price = Number(d.price_cents);
          if (!title || !Number.isInteger(duration) || duration < 15 || duration > 360 ||
              !Number.isInteger(capacity) || capacity < 1 || capacity > 200 ||
              !Number.isInteger(price) || price < 0 || price > 10000000)
            return INVALID('Invalid course details.');
          const r = await env.DB.prepare(`INSERT INTO courses (title, description, category, duration_minutes, capacity, price_cents, currency)
            VALUES (?, ?, ?, ?, ?, ?, 'EUR')`).bind(title, description, category, duration, capacity, price).run();
          return json({ id: r.meta.last_row_id }, 201);
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/courses\/\d+$/.test(path)) {
          const id = Number(path.split('/').at(-1));
          const d = await parseJSON(request);
          if (typeof d.active !== 'boolean') return INVALID('Expected active boolean.');
          await env.DB.prepare('UPDATE courses SET active=? WHERE id=?').bind(d.active ? 1 : 0, id).run();
          return json({ ok: true });
        }
        if (request.method === 'POST' && path === '/api/admin/sessions') {
          const d = await parseJSON(request);
          const courseId = Number(d.course_id);
          const start = safeString(d.starts_at, 40);
          const end = safeString(d.ends_at, 40);
          if (!Number.isSafeInteger(courseId) || !validISO(start) || !validISO(end) ||
              Date.parse(start) < Date.now() || Date.parse(end) <= Date.parse(start) ||
              Date.parse(end) - Date.parse(start) > 7 * 3600000)
            return INVALID('Invalid session date or time.');
          try {
            const r = await env.DB.prepare(`INSERT INTO sessions (course_id, starts_at, ends_at) VALUES (?, ?, ?)`)
              .bind(courseId, start, end).run();
            return json({ id: r.meta.last_row_id }, 201);
          } catch (error) {
            if (String(error).includes('UNIQUE constraint')) return INVALID('This course already has a session at this time.', 409);
            throw error;
          }
        }
        if (request.method === 'POST' && /^\/api\/admin\/sessions\/\d+\/cancel$/.test(path)) {
          const id = Number(path.split('/')[4]);
          await env.DB.prepare('UPDATE sessions SET cancelled = 1 WHERE id = ?').bind(id).run();
          return json({ ok: true, note: 'Existing participants must be notified manually.' });
        }
        if (request.method === 'POST' && /^\/api\/admin\/bookings\/[a-f0-9-]+\/cancel$/.test(path)) {
          const id = path.split('/')[4];
          await env.DB.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='confirmed'").bind(id).run();
          return json({ ok: true, note: 'Customer must be notified manually.' });
        }
      }
      return INVALID('Not found.', 404);
    } catch (error) {
      if (error instanceof SyntaxError) return INVALID('Malformed JSON.');
      if (error.message === 'Payload too large.') return INVALID(error.message, 413);
      console.error('Request error', String(error));
      return INVALID('Unexpected server error. Please try again.', 500);
    }
  }
};
