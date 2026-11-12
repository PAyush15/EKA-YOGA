import { paymentMethods, paymentInstructions } from './payment-config.js';

const MINUTE = 60_000;
const RETRY_WINDOW = 6 * 24 * 60 * MINUTE; // Apps Script keeps receipts for seven days.
const recipientStates = ['accepted', 'quota', 'failed', 'review'];
const scriptErrors = {
  config: 'Apps Script secret or admin inbox is misconfigured.',
  invalid: 'Apps Script rejected the email request.',
  busy: 'Apps Script is busy. The queue will retry.',
  service: 'Apps Script could not complete the request.'
};

export function queueEmail(db, id, kind) {
  return db.prepare(`INSERT OR IGNORE INTO email_jobs(id,booking_id,kind)
    SELECT ?,id,? FROM bookings WHERE id=? AND status='confirmed'`).bind(id + ':' + kind, kind, id);
}

async function send(env, job, booking) {
  const endpoint = new URL(env.NOTIFY_WEBHOOK_URL);
  if (endpoint.protocol !== 'https:' || endpoint.host !== 'script.google.com' ||
      endpoint.username || endpoint.password || !endpoint.pathname.endsWith('/exec')) {
    return { error: 'Invalid Apps Script deployment URL.' };
  }

  const res = await fetch(endpoint.href, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      secret: env.NOTIFY_SHARED_SECRET,
      reportVersion: 2,
      eventId: job.id,
      id: booking.id,
      paid: job.kind === 'paid',
      studioName: env.STUDIO_NAME || 'Yoga by Krunali',
      studioTimezone: env.STUDIO_TIMEZONE || 'America/Chicago',
      firstName: booking.first_name,
      lastName: booking.last_name,
      email: booking.email,
      phone: booking.phone,
      course: booking.title,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      duration: (Date.parse(booking.ends_at) - Date.parse(booking.starts_at)) / MINUTE,
      instructions: paymentInstructions(booking.price_cents, paymentMethods(env)),
      paymentUrl: ''
    })
  });
  if (!res.ok) return { error: 'Apps Script returned HTTP ' + res.status + '.' };
  const body = (await res.text()).trim();
  // A Worker update can deploy before the user updates the Apps Script web app.
  if (body === 'OK') return { customer: 'accepted', instructor: 'accepted' };
  if (body === 'Forbidden') return { error: scriptErrors.config };
  if (body === 'ERROR') return { error: scriptErrors.service };
  let report;
  try { report = JSON.parse(body); } catch {}
  if (report?.version === 2) {
    if (Object.hasOwn(scriptErrors, report.error)) return { error: scriptErrors[report.error] };
    if (recipientStates.includes(report.customer) && recipientStates.includes(report.instructor)) return report;
  }
  return { error: 'Unexpected Apps Script response. Check the web app deployment and access settings.' };
}

async function finish(db, job, { status, attempts = job.attempts, next = 0, error = null }) {
  await db.prepare(`UPDATE email_jobs SET status=?,attempts=?,next_attempt=?,lease_until=0,
    delivered_at=?,last_error=? WHERE id=? AND lease_until=?`)
    .bind(status, attempts, next, status === 'sent' ? new Date().toISOString() : null, error, job.id, job.lease_until).run();
}

async function deliverJob(env, job) {
  const db = env.DB;
  const now = Date.now();
  const booking = await db.prepare(`SELECT b.*,s.starts_at,s.ends_at,s.cancelled,c.title,c.price_cents,p.paid_at
    FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN courses c ON c.id=s.course_id
    LEFT JOIN payments p ON p.booking_id=b.id WHERE b.id=?`).bind(job.booking_id).first();
  if (!booking || booking.cancelled || booking.status !== 'confirmed') {
    return finish(db, job, { status: 'skipped', error: 'Booking cancelled or inactive. No further attempts.' });
  }
  if (job.kind === 'reserved' && booking.paid_at) {
    return finish(db, job, { status: 'skipped', error: 'Payment recorded. The confirmation replaces any outstanding payment request.' });
  }
  const progress = await db.prepare('SELECT * FROM email_job_progress WHERE job_id=?').bind(job.id).first();
  // Legacy jobs do not have a first-send timestamp. The booking/payment timestamp is a conservative bound.
  const legacyTimestamp = job.kind === 'paid' ? booking.paid_at : booking.created_at;
  const legacyStart = Date.parse(legacyTimestamp?.includes(' ') ? legacyTimestamp.replace(' ', 'T') + 'Z' : legacyTimestamp);
  const firstAttempt = progress?.first_attempt_at ?? (job.attempts > 0 && Number.isFinite(legacyStart) ? legacyStart : now);
  if (now - firstAttempt >= RETRY_WINDOW) {
    return finish(db, job, { status: 'review', error: 'Retry window ended. Check Gmail before resending to avoid duplicates.' });
  }

  let result;
  if (!env.NOTIFY_WEBHOOK_URL || !env.NOTIFY_SHARED_SECRET) {
    result = { error: 'Missing Cloudflare email settings. Check NOTIFY_WEBHOOK_URL and NOTIFY_SHARED_SECRET.' };
  } else {
    await db.prepare('INSERT OR IGNORE INTO email_job_progress(job_id,first_attempt_at) VALUES(?,?)')
      .bind(job.id, firstAttempt).run();
    try {
      result = await send(env, job, booking);
    } catch {
      result = { error: 'Apps Script request failed or timed out. Send outcome unconfirmed.' };
    }
  }

  if (result.customer) {
    const customer = progress?.customer_status === 'accepted' ? 'accepted' : result.customer;
    const instructor = progress?.instructor_status === 'accepted' ? 'accepted' : result.instructor;
    await db.prepare('UPDATE email_job_progress SET customer_status=?,instructor_status=? WHERE job_id=?')
      .bind(customer, instructor, job.id).run();
    if (customer === 'accepted' && instructor === 'accepted') {
      return finish(db, job, { status: 'sent', attempts: job.attempts + 1 });
    }
    if ([customer, instructor].every(status => status === 'accepted' || status === 'review')) {
      return finish(db, job, { status: 'review', attempts: job.attempts + 1, error: 'Send outcome unconfirmed for a recipient. Check Gmail before resending.' });
    }
    result.error = [customer, instructor].includes('quota')
      ? 'Google email quota reached. Waiting for quota to become available.'
      : 'One or more recipients still need attention. See recipient statuses.';
  }

  const attempts = job.attempts + 1;
  const quotaReached = result.customer === 'quota' || result.instructor === 'quota';
  // Quota-limited jobs keep retrying long enough to cover Google's 24-hour reset.
  const maxAttempts = quotaReached ? 16 : 8;
  const delay = Math.min(6 * 60 * MINUTE, 5 * MINUTE * 2 ** Math.min(attempts - 1, 7));
  await finish(db, job, {
    status: attempts >= maxAttempts ? 'failed' : 'pending',
    attempts,
    next: now + delay,
    error: result.error
  });
}

export async function deliverEmails(env, onlyId) {
  const started = Date.now();
  const { results } = await env.DB.prepare(`SELECT id FROM email_jobs
    WHERE lease_until<=? AND (
      (status='pending' AND next_attempt<=?) OR
      (status IN ('pending','failed') AND kind='reserved'
        AND EXISTS (SELECT 1 FROM payments WHERE booking_id=email_jobs.booking_id))
    ) ${onlyId ? 'AND booking_id=?' : ''}
    ORDER BY CASE WHEN kind='paid' THEN 0 ELSE 1 END, next_attempt LIMIT 10`)
    .bind(started, started, ...(onlyId ? [onlyId] : [])).all();

  for (const item of results) {
    // Leave enough of waitUntil's window for the final request. Cron can finish the batch.
    const now = Date.now();
    if (onlyId && now - started > 8_000) break;
    const job = await env.DB.prepare(`UPDATE email_jobs SET lease_until=? WHERE id=? AND lease_until<=?
      AND ((status='pending' AND next_attempt<=?) OR
        (status IN ('pending','failed') AND kind='reserved'
          AND EXISTS (SELECT 1 FROM payments WHERE booking_id=email_jobs.booking_id)))
      RETURNING *`).bind(now + MINUTE, item.id, now, now).first();
    if (job) await deliverJob(env, job);
  }
}
