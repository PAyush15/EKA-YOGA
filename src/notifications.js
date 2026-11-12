import { emailPayload } from './resend.js';
export function queueEmail(db,id,kind) {
  return db.prepare(`INSERT OR IGNORE INTO email_jobs(id,booking_id,kind)
    SELECT ?,id,? FROM bookings WHERE id=? AND status='confirmed'`).bind(id+':'+kind,kind,id);
}
const email=value=>/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value||'');
export function emailSettings(env) {
  const missing=['RESEND_API_KEY','EMAIL_FROM','ADMIN_EMAIL'].filter(k=>!env[k]);
  if(missing.length)return 'Missing Cloudflare settings: '+missing.join(', ');
  if(!email(env.ADMIN_EMAIL)||!email(env.EMAIL_REPLY_TO||env.ADMIN_EMAIL))return 'Invalid ADMIN_EMAIL or EMAIL_REPLY_TO';
  if(/[\r\n]/.test(env.EMAIL_FROM)||!email(env.EMAIL_FROM.match(/<([^<>]+)>$/)?.[1]||env.EMAIL_FROM))return 'Invalid EMAIL_FROM';
  return '';
}
export async function deliverEmails(env,onlyId) {
  const started=Date.now();
  const {results}=await env.DB.prepare(`SELECT id FROM email_jobs WHERE status='pending' AND next_attempt<=? AND lease_until<=? ${onlyId?'AND booking_id=?':''} ORDER BY next_attempt LIMIT 10`).bind(started,started,...(onlyId?[onlyId]:[])).all();
  for(const item of results) {
    // Keep request-triggered background work within Workers' waitUntil budget; cron resumes the queue.
    if(Date.now()-started>7000)break;
    const now=Date.now();
    const job=await env.DB.prepare(`UPDATE email_jobs SET lease_until=? WHERE id=? AND status='pending' AND lease_until<=? RETURNING *`).bind(now+60000,item.id,now).first();
    if(!job)continue;
    try {await deliverJob(env,job);} catch {
      await env.DB.prepare("UPDATE email_jobs SET lease_until=0,next_attempt=?,last_error='Internal email processing error; retry scheduled' WHERE id=?").bind(Date.now()+300000,job.id).run();
    }
  }
}
async function deliverJob(env,job) {
  const db=env.DB,now=Date.now();
  const b=await db.prepare(`SELECT b.*,s.starts_at,s.ends_at,s.cancelled,c.title,c.price_cents,
    a.address_line1,a.address_line2,a.address_city,a.address_state,a.address_zip,
    EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=b.id) AS paid
    FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN courses c ON c.id=s.course_id
    LEFT JOIN booking_addresses a ON a.booking_id=b.id WHERE b.id=?`).bind(job.booking_id).first();
  const reason=!b||b.cancelled||b.status!=='confirmed'?'Booking cancelled or inactive':job.kind==='reserved'&&b.paid?'Payment already recorded; confirmation replaces the unsent payment request':null;
  if(reason) {
    await db.batch([
      db.prepare("UPDATE email_deliveries SET status='review',last_error=? WHERE job_id=? AND status IN ('pending','failed') AND first_attempt IS NOT NULL").bind(reason+'; previous send outcome uncertain, check Resend',job.id),
      db.prepare("UPDATE email_deliveries SET status='skipped',last_error=? WHERE job_id=? AND status IN ('pending','failed') AND first_attempt IS NULL").bind(reason,job.id),
      db.prepare("UPDATE email_jobs SET status='skipped',last_error=?,lease_until=0 WHERE id=?").bind(reason,job.id)
    ]);return;
  }
  let deliveries=(await db.prepare('SELECT * FROM email_deliveries WHERE job_id=?').bind(job.id).all()).results;
  if(!deliveries.length&&job.attempts>0) {
    // Apps Script may already have sent one recipient. Do not blindly resend on migration.
    await db.prepare("UPDATE email_jobs SET status='review',lease_until=0,last_error='Legacy Apps Script attempt: check its send history before resending' WHERE id=?").bind(job.id).run();return;
  }
  if(!deliveries.length) {
    await db.batch(['customer','instructor'].map(recipient=>db.prepare('INSERT OR IGNORE INTO email_deliveries(id,job_id,recipient) VALUES(?,?,?)').bind(job.id+':'+recipient,job.id,recipient)));
    deliveries=(await db.prepare('SELECT * FROM email_deliveries WHERE job_id=?').bind(job.id).all()).results;
  }
  for(const delivery of deliveries) {
    if(delivery.status!=='pending'||delivery.next_attempt>now)continue;
    const configError=emailSettings(env);
    if(configError) {await db.prepare('UPDATE email_deliveries SET last_error=?,next_attempt=? WHERE id=?').bind(configError,now+300000,delivery.id).run();continue;}
    if(delivery.first_attempt&&now-delivery.first_attempt>=23*3600000) {
      await db.prepare("UPDATE email_deliveries SET status='review',last_error='Send outcome uncertain; check Resend before resending (duplicate protection window expired)' WHERE id=?").bind(delivery.id).run();continue;
    }
    // Persist exact request bytes so retries keep the same idempotency key AND payload.
    const payload=delivery.payload||JSON.stringify(emailPayload(env,b,job.kind,delivery.recipient));
    await db.prepare('UPDATE email_deliveries SET payload=?,first_attempt=COALESCE(first_attempt,?) WHERE id=?').bind(payload,now,delivery.id).run();
    const attempts=delivery.attempts+1;
    let failure='Network timeout or unavailable service; outcome not yet known',status='pending',definiteRejection=false;
    try {
      const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':delivery.id},body:payload,signal:AbortSignal.timeout(8000)});
      const data=await res.json().catch(()=>({}));
      if(res.ok&&typeof data.id==='string') {
        await db.prepare("UPDATE email_deliveries SET status='accepted',provider_id=?,accepted_at=?,attempts=?,last_error=NULL,payload=NULL WHERE id=?").bind(data.id,new Date().toISOString(),attempts,delivery.id).run();continue;
      }
      const code=typeof data.name==='string'?data.name.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80):'request_error';
      failure=`Resend HTTP ${res.status} (${code})`;
      definiteRejection=res.status>=400&&res.status<500&&![408,409].includes(res.status)&&!delivery.first_attempt;
      if(res.status>=400&&res.status<500&&![408,409,429].includes(res.status))status='failed';
    }catch{}
    if(attempts>=16)status='failed';
    await db.prepare(`UPDATE email_deliveries SET status=?,attempts=?,next_attempt=?,last_error=?,first_attempt=CASE WHEN ? THEN NULL ELSE first_attempt END, payload=CASE WHEN ? THEN NULL ELSE payload END WHERE id=?`)
      .bind(status,attempts,now+Math.min(6*3600000,300000*2**Math.min(attempts-1,7)),failure,definiteRejection?1:0,definiteRejection&&status==='failed'?1:0,delivery.id).run();
  }
  const rows=(await db.prepare('SELECT status,next_attempt,last_error FROM email_deliveries WHERE job_id=?').bind(job.id).all()).results;
  const pending=rows.filter(r=>r.status==='pending');
  const status=pending.length?'pending':rows.some(r=>r.status==='review')?'review':rows.some(r=>r.status==='failed')?'failed':'sent';
  await db.prepare('UPDATE email_jobs SET status=?,next_attempt=?,lease_until=0,last_error=? WHERE id=?')
    .bind(status,pending.length?Math.min(...pending.map(r=>r.next_attempt)):0,rows.find(r=>r.last_error)?.last_error||null,job.id).run();
}
export async function retryEmails(db,id) {
  const now=Date.now();
  // Never reset uncertain outcomes, accepted sends, bounces, or legacy attempts.
  await db.batch([
    db.prepare(`UPDATE email_deliveries SET status='pending',next_attempt=0,attempts=0 WHERE job_id IN
      (SELECT id FROM email_jobs WHERE booking_id=? AND lease_until<=? AND status IN ('pending','failed'))
      AND status IN ('pending','failed') AND (first_attempt IS NULL OR first_attempt>?)`).bind(id,now,now-23*3600000),
    db.prepare(`UPDATE email_jobs SET status='pending',next_attempt=0 WHERE booking_id=? AND lease_until<=?
      AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM email_deliveries d WHERE d.job_id=email_jobs.id AND d.status='pending')`).bind(id,now)
  ]);
}
