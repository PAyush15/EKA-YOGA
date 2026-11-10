import { paymentMethods, paymentInstructions } from './payment-config.js';
// Store references, not duplicate customer data or shared secrets, in the queue.
export function queueEmail(db,id,kind) {
  return db.prepare(`INSERT OR IGNORE INTO email_jobs(id,booking_id,kind)
    SELECT ?,id,? FROM bookings WHERE id=? AND status='confirmed'`).bind(id+':'+kind,kind,id);
}
export async function deliverEmails(env,onlyId) {
  const now=Date.now();
  const {results}=await env.DB.prepare(`SELECT id FROM email_jobs WHERE status='pending' AND next_attempt<=? AND lease_until<=? ${onlyId?'AND booking_id=?':''} ORDER BY next_attempt LIMIT 10`).bind(now,now,...(onlyId?[onlyId]:[])).all();
  for(const item of results) {
    const job=await env.DB.prepare(`UPDATE email_jobs SET lease_until=? WHERE id=? AND status='pending' AND lease_until<=? RETURNING *`).bind(now+60000,item.id,now).first();
    if(!job)continue;
    const b=await env.DB.prepare(`SELECT b.*,s.starts_at,s.ends_at,s.cancelled,c.title,c.price_cents,
      EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=b.id) AS paid
      FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN courses c ON c.id=s.course_id WHERE b.id=?`).bind(job.booking_id).first();
    if(!b||b.cancelled||b.status!=='confirmed'||(job.kind==='reserved'&&b.paid)) {
      await env.DB.prepare("UPDATE email_jobs SET status='skipped',lease_until=0 WHERE id=?").bind(job.id).run();continue;
    }
    let failure='';
    if(!env.NOTIFY_WEBHOOK_URL||!env.NOTIFY_SHARED_SECRET)failure='Email settings missing';
    else try {
      const endpoint=new URL(env.NOTIFY_WEBHOOK_URL);
      if(endpoint.protocol!=='https:'||endpoint.hostname!=='script.google.com'||!endpoint.pathname.endsWith('/exec'))throw Error('Invalid email endpoint');
      const methods=paymentMethods(env);
      const res=await fetch(endpoint.href,{method:'POST',headers:{'content-type':'text/plain;charset=utf-8'},signal:AbortSignal.timeout(20000),body:JSON.stringify({
        secret:env.NOTIFY_SHARED_SECRET,eventId:job.id,id:b.id,paid:job.kind==='paid',
        studioName:env.STUDIO_NAME||'Yoga by Krunali',studioTimezone:'America/Chicago',
        firstName:b.first_name,lastName:b.last_name,email:b.email,phone:b.phone,
        course:b.title,startsAt:b.starts_at,endsAt:b.ends_at,duration:(Date.parse(b.ends_at)-Date.parse(b.starts_at))/60000,
        instructions:paymentInstructions(b.price_cents,methods),paymentUrl:''
      })});
      if(!res.ok||(await res.text()).trim()!=='OK')failure='Email service rejected delivery';
    } catch {failure='Email service unavailable or misconfigured';}
    const attempts=job.attempts+1;
    await env.DB.prepare(`UPDATE email_jobs SET status=?,attempts=?,next_attempt=?,lease_until=0,delivered_at=?,last_error=? WHERE id=?`)
      .bind(failure?(attempts>=8?'failed':'pending'):'sent',attempts,now+Math.min(6*3600000,300000*2**(attempts-1)),failure?null:new Date().toISOString(),failure||null,job.id).run();
  }
}
