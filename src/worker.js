import { bookableStart, HOURS_TEXT } from '../public/booking-rules.js';
import { paymentMethods, paymentInstructions } from './payment-config.js';
import { ensureSetup } from './setup.js';
import { queueEmail, deliverEmails } from './notifications.js';
import { authRoute, currentUser } from './auth.js';
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
function cleanEmail(value) { const email = safeString(value, 200).toLowerCase(); return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : ''; }
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' '));
const ADDRESS_ERROR = 'Enter a US street address, city, valid state abbreviation, and ZIP code.';
function bookingAddress(data) {
  const street = safeString(data.address_line1,120);
  const unit = safeString(data.address_line2,80);
  const city = safeString(data.address_city,80);
  const state = typeof data.address_state === 'string' ? data.address_state.trim().toUpperCase() : '';
  const zip = typeof data.address_zip === 'string' ? data.address_zip.trim() : '';
  if (!street || !city || !US_STATES.has(state) || !/^\d{5}(-\d{4})?$/.test(zip)) return null;
  return [street, unit, city, state, zip];
}
const saveBookingAddress = (db, id, address) => db.prepare(`
  INSERT INTO booking_addresses(booking_id,address_line1,address_line2,address_city,address_state,address_zip)
  SELECT id,?,?,?,?,? FROM bookings WHERE id=?
  ON CONFLICT(booking_id) DO UPDATE SET
    address_line1=excluded.address_line1, address_line2=excluded.address_line2,
    address_city=excluded.address_city, address_state=excluded.address_state, address_zip=excluded.address_zip
`).bind(...address,id);

function adminOK(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const split = decoded.indexOf(':');
    if(split < 1)return false;
    const user=decoded.slice(0,split), pass=decoded.slice(split+1);
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
  if (!request.body) throw new SyntaxError('Expected a JSON body.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, value = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new Error('Payload too large.');
      }
      value += decoder.decode(chunk.value, {stream:true});
    }
  } finally { reader.releaseLock(); }
  const data=JSON.parse(value + decoder.decode());
  if(!data || typeof data!=='object' || Array.isArray(data))throw new SyntaxError('Expected an object.');
  return data;
}
function validISO(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value; }

export default {
  async scheduled(event, env, ctx) { await ensureSetup(env.DB); await deliverEmails(env); },
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
      await ensureSetup(env.DB);

      const authResponse = await authRoute(request, env, parseJSON);
      if (authResponse) return authResponse;

      if (request.method === 'GET' && path === '/api/config')
        return json({ studioName: env.STUDIO_NAME || 'Yoga Studio', timezone: env.STUDIO_TIMEZONE || 'America/Chicago', whatsapp: env.WHATSAPP_NUMBER || '', googleClientId: env.GOOGLE_CLIENT_ID || '' });

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

      if (request.method === 'GET' && path === '/api/busy') {
        const {results} = await env.DB.prepare(`SELECT DISTINCT s.starts_at, s.ends_at FROM sessions s
          JOIN bookings b ON b.session_id=s.id
          WHERE s.cancelled=0 AND b.status='confirmed' AND s.ends_at >= ? ORDER BY s.starts_at`)
          .bind(new Date().toISOString()).all();
        return json({intervals:results});
      }

      if (request.method === 'POST' && path === '/api/bookings') {
        if (!sameOrigin(request)) return INVALID('Invalid origin.',403);
        const d = await parseJSON(request);
        const customer = await currentUser(request, env);
        if (d.account_required && !customer) return INVALID('Your sign-in expired. Please sign in again before booking.',401);
        const first = safeString(d.first_name,70), last = safeString(d.last_name,70);
        const email = cleanEmail(customer ? customer.email : d.email), phone = safeString(d.phone,50);
        if (!first || !last || !email || !/^[+\d(). -]+$/.test(phone) || phone.replace(/\D/g,'').length < 7 || d.website)
          return INVALID('Enter your name, email and phone number.');
        const address = bookingAddress(d);
        if (!address) return INVALID(ADDRESS_ERROR);
        const start = d.starts_at;
        if (!validISO(start) || !bookableStart(Date.parse(start))) return INVALID('Choose an available date at least three calendar days ahead. '+HOURS_TEXT);
        const course = await env.DB.prepare('SELECT * FROM courses WHERE id=? AND active=1').bind(Number(d.course_id)||0).first();
        if (!course) return INVALID('Class unavailable.');
        const duration = course.duration_minutes;
        if(d.minutes!==undefined && d.minutes!==duration) return INVALID('This class has a fixed duration of '+duration+' minutes.');
        // Verify before any reservation or notification is created. Fail closed.
        if (!env.TURNSTILE_SECRET_KEY) return INVALID('Booking verification is not configured. Please contact the studio.',503);
        const token=d['cf-turnstile-response'];
        if(typeof token!=='string' || !token || token.length>2048) return INVALID('Please complete the security check.',403);
        try {
          const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token}),
            signal:AbortSignal.timeout(8000)
          });
          if(!response.ok) return INVALID('Security check unavailable. Please try again.',503);
          const result=await response.json();
          if(result.success!==true || result.hostname!==url.hostname || result.action!=='booking')
            return INVALID('Security check expired or failed. Please try again.',403);
        } catch { return INVALID('Security check unavailable. Please try again.',503); }
        const end = new Date(Date.parse(start)+duration*60000).toISOString();
        const id = crypto.randomUUID();
        // D1 executes the batch as one transaction. An existing active interval
        // blocks every course, including a second booking for the same party.
        const busy = `EXISTS (SELECT 1 FROM sessions x JOIN bookings b ON b.session_id=x.id
          WHERE x.cancelled=0 AND b.status='confirmed' AND x.starts_at < ? AND x.ends_at > ?)`;
        const [,reservation] = await env.DB.batch([
          env.DB.prepare(`INSERT INTO sessions(course_id,starts_at,ends_at)
            SELECT ?,?,? WHERE NOT ${busy}
            ON CONFLICT(course_id,starts_at) DO UPDATE SET ends_at=excluded.ends_at,cancelled=0
            WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE session_id=sessions.id AND status='confirmed')`)
            .bind(course.id,start,end,end,start),
          env.DB.prepare(`INSERT INTO bookings(id,session_id,first_name,last_name,email,phone)
            SELECT ?,s.id,?,?,?,? FROM sessions s JOIN courses c ON c.id=s.course_id
            WHERE c.active=1 AND s.course_id=? AND s.starts_at=? AND s.ends_at=? AND s.cancelled=0 AND NOT ${busy}`)
            .bind(id,first,last,email,phone,course.id,start,end,end,start),
          saveBookingAddress(env.DB,id,address),
          queueEmail(env.DB,id,'reserved'),
          ...(customer ? [env.DB.prepare('INSERT INTO customer_bookings(booking_id,customer_id) SELECT id,? FROM bookings WHERE id=?').bind(customer.id,id)] : [])
        ]);
        if (!reservation.meta.changes) return INVALID('That time is unavailable. Choose another start time.',409);
        const methods=paymentMethods(env);
        const instructions=paymentInstructions(course.price_cents,methods);
        ctx.waitUntil(deliverEmails(env,id));
        return json({id,instructions,methods,emailStatus:'queued'},201);
      }

      // Everything below requires administrator HTTP Basic authentication.
      if (path.startsWith('/api/admin/')) {
        if (!adminOK(request, env)) return demandAdmin();
        if (request.method !== 'GET' && !sameOrigin(request)) return INVALID('Invalid request origin.', 403);
        if (request.method === 'POST' && /^\/api\/admin\/bookings\/[a-f0-9-]+\/paid$/.test(path)) {
          const id = path.split('/')[4];
          const [paid] = await env.DB.batch([
            env.DB.prepare(`INSERT OR IGNORE INTO payments(booking_id,paid_at)
              SELECT b.id,datetime('now') FROM bookings b JOIN sessions s ON s.id=b.session_id
              WHERE b.id=? AND b.status='confirmed' AND s.cancelled=0`).bind(id),
            env.DB.prepare(`INSERT OR IGNORE INTO email_jobs(id,booking_id,kind)
              SELECT ?,booking_id,'paid' FROM payments WHERE booking_id=?`).bind(id+':paid',id)
          ]);
          if (!paid.meta.changes) return INVALID('Already paid or inactive reservation.',409);
          ctx.waitUntil(deliverEmails(env,id));
          return json({ok:true});
        }
        if (request.method === 'POST' && /^\/api\/admin\/bookings\/[a-f0-9-]+\/retry-email$/.test(path)) {
          const id=path.split('/')[4];
          await env.DB.prepare("UPDATE email_jobs SET status='pending',attempts=0,next_attempt=0 WHERE booking_id=? AND status IN ('pending','failed') AND lease_until<=?").bind(id,Date.now()).run();
          ctx.waitUntil(deliverEmails(env,id));
          return json({ok:true});
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/bookings\/[a-f0-9-]+\/address$/.test(path)) {
          const address = bookingAddress(await parseJSON(request));
          if (!address) return INVALID(ADDRESS_ERROR);
          const result = await saveBookingAddress(env.DB,path.split('/')[4],address).run();
          if (!result.meta.changes) return INVALID('Booking not found.',404);
          return json({ok:true});
        }
        if (request.method === 'GET' && path === '/api/admin/overview') {
          const [courses, sessions, bookings, emails] = await Promise.all([
            env.DB.prepare(`${courseSelect} ORDER BY id DESC`).all(),
            env.DB.prepare(`SELECT upcoming.*, EXISTS (
              SELECT 1 FROM bookings b JOIN payments p ON p.booking_id=b.id
              WHERE b.session_id=upcoming.id AND b.status='confirmed'
            ) AS paid FROM (${sessionSelect} WHERE s.starts_at >= ? ORDER BY s.starts_at LIMIT 200) upcoming ORDER BY starts_at`).bind(new Date().toISOString()).all(),
            env.DB.prepare(`SELECT b.id, b.session_id, b.first_name, b.last_name, b.email, b.phone, b.status,
              a.address_line1, a.address_line2, a.address_city, a.address_state, a.address_zip,
              (SELECT paid_at FROM payments WHERE booking_id=b.id) AS paid_at, b.created_at, s.starts_at, c.title AS course_title
              FROM bookings b JOIN sessions s ON s.id=b.session_id
              JOIN courses c ON c.id=s.course_id
              LEFT JOIN booking_addresses a ON a.booking_id=b.id ORDER BY b.created_at DESC LIMIT 300`).all(),
            env.DB.prepare('SELECT id,booking_id,kind,status,attempts,last_error FROM email_jobs ORDER BY rowid DESC LIMIT 600').all()
          ]);
          return json({ courses: courses.results, sessions: sessions.results,
            bookings: bookings.results, emails: emails.results });
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
            VALUES (?, ?, ?, ?, ?, ?, 'USD')`).bind(title, description, category, duration, capacity, price).run();
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
          await env.DB.batch([env.DB.prepare('UPDATE sessions SET cancelled=1 WHERE id=?').bind(id), env.DB.prepare("UPDATE bookings SET status='cancelled' WHERE session_id=?").bind(id)]);
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




