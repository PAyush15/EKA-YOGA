// No external email is sent. Exercise the actual SQL and Worker routes against SQLite.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { ensureSetup } from '../src/setup.js';
import { deliverEmails, queueEmail, retryEmails } from '../src/notifications.js';
import { verifyWebhook, resendWebhook } from '../src/resend.js';
import worker from '../src/worker.js';
const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync('schema.sql','utf8'));
class Statement {
  constructor(sql){this.sql=sql;this.params=[];}
  bind(...p){this.params=p;return this;}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.params)};}
  async first(){return sqlite.prepare(this.sql).get(...this.params)||null;}
  async run(){const r=sqlite.prepare(this.sql).run(...this.params);return {meta:{changes:r.changes}};}
}
const db={prepare:s=>new Statement(s),batch:async statements=>{sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
sqlite.exec('DROP TABLE email_events; DROP TABLE email_deliveries;');
await ensureSetup(db); // Additive runtime migration also works without the new tables.
const env={DB:db,RESEND_API_KEY:'test-only',EMAIL_FROM:'Yoga <bookings@example.org>',ADMIN_EMAIL:'owner@example.org',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password'};
let now=Date.now();const realNow=Date.now;Date.now=()=>now;
const originalFetch=globalThis.fetch;let calls=[];let outcome=()=>Response.json({id:crypto.randomUUID()});
globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');calls.push(options);return outcome(options);};
let bookingCount=0;
function booking(){const id=crypto.randomUUID();const session=sqlite.prepare("INSERT INTO sessions(course_id,starts_at,ends_at) VALUES(1,?,?)").run(new Date(Date.parse('2026-12-01T16:00:00Z')+(++bookingCount)*86400000).toISOString(),new Date(Date.parse('2026-12-01T17:00:00Z')+bookingCount*86400000).toISOString()).lastInsertRowid;sqlite.prepare("INSERT INTO bookings(id,session_id,first_name,last_name,email,phone) VALUES(?,?,'Test','Guest','customer@example.org','5550123')").run(id,Number(session));sqlite.prepare("INSERT INTO booking_addresses VALUES(?,'123 Example St','','Austin','TX','78701')").run(id);return id;}
const rows=id=>sqlite.prepare('SELECT d.* FROM email_deliveries d JOIN email_jobs j ON j.id=d.job_id WHERE j.booking_id=? ORDER BY recipient').all(id);
const job=id=>sqlite.prepare('SELECT * FROM email_jobs WHERE booking_id=? AND kind=\'reserved\'').get(id);
async function reserve(){const id=booking();await queueEmail(db,id,'reserved').run();return id;}
let id=await reserve();await deliverEmails(env,id);
assert.equal(calls.length,2);assert.ok(rows(id).every(d=>d.status==='accepted'));assert.equal(job(id).status,'sent');
assert.deepEqual(calls.map(c=>JSON.parse(c.body).to[0]).sort(),['customer@example.org','owner@example.org']);
assert.match(JSON.parse(calls[0].body).text,/123 Example St/);assert.doesNotMatch(JSON.parse(calls[0].body).text,/reply with the address/i);
await deliverEmails(env,id);await retryEmails(db,id);await deliverEmails(env,id);assert.equal(calls.length,2);
console.log('PASS: both recipients, address, templates, accepted status and no resending accepted mail.');

id=await reserve();calls=[];outcome=o=>JSON.parse(o.body).to[0]==='customer@example.org'?Response.json({name:'rate_limit_exceeded'},{status:429}):Response.json({id:crypto.randomUUID()});
await deliverEmails(env,id);assert.equal(job(id).status,'pending');assert.equal(rows(id)[0].first_attempt,null);
const originalBody=calls[0].body;now+=300001;outcome=()=>Response.json({id:crypto.randomUUID()});await deliverEmails(env,id);
assert.equal(calls.length,3);assert.equal(calls[2].body,originalBody);assert.equal(calls[2].headers['Idempotency-Key'],calls[0].headers['Idempotency-Key']);assert.equal(job(id).status,'sent');
console.log('PASS: partial failure retries only unsent recipient with stable request and key.');

id=await reserve();outcome=()=>{throw Error('timeout');};await deliverEmails(env,id);assert.ok(rows(id).every(d=>d.first_attempt));
now+=24*3600000;calls=[];await deliverEmails(env,id);assert.equal(job(id).status,'review');assert.equal(calls.length,0);
await retryEmails(db,id);assert.equal(job(id).status,'review');
console.log('PASS: ambiguous outcomes stop for review before duplicate protection expires; retry cannot bypass guard.');

id=await reserve();outcome=()=>Response.json({name:'daily_quota_exceeded'},{status:429});
for(let n=0;n<7;n++){await deliverEmails(env,id);now+=6*3600000;}
assert.equal(job(id).status,'pending');assert.ok(rows(id).every(d=>d.first_attempt===null));
outcome=()=>Response.json({id:crypto.randomUUID()});await deliverEmails(env,id);assert.equal(job(id).status,'sent');
console.log('PASS: explicit quota rejection can retry across daily reset without ambiguous-send duplicates.');

id=await reserve();calls=[];await deliverEmails({...env,RESEND_API_KEY:''},id);assert.equal(calls.length,0);assert.match(rows(id)[0].last_error,/RESEND_API_KEY/);
sqlite.prepare("INSERT INTO payments VALUES(?,datetime('now'))").run(id);await retryEmails(db,id);await deliverEmails(env,id);
assert.equal(job(id).status,'skipped');assert.match(job(id).last_error,/Payment already recorded/);assert.ok(rows(id).every(d=>d.status==='skipped'));
await queueEmail(db,id,'paid').run();await deliverEmails(env,id);assert.equal(calls.length,2);assert.ok(calls.every(c=>JSON.parse(c.body).subject.includes('confirmed')));
console.log('PASS: missing configuration visible, payment supersedes unsent request with explicit reason, confirmation still sends.');

id=await reserve();sqlite.prepare('UPDATE email_jobs SET attempts=1 WHERE booking_id=?').run(id);calls=[];await deliverEmails(env,id);assert.equal(job(id).status,'review');assert.equal(calls.length,0);
id=await reserve();sqlite.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(id);await deliverEmails(env,id);assert.equal(job(id).status,'skipped');assert.match(job(id).last_error,/cancelled/);
console.log('PASS: legacy partial sends require review; cancelled bookings do not send.');

id=await reserve();outcome=()=>Response.json({name:'validation_error'},{status:403});await deliverEmails(env,id);
assert.ok(rows(id).every(d=>d.status==='failed'&&d.first_attempt===null&&d.payload===null));
env.EMAIL_FROM='Yoga <corrected@example.org>';outcome=()=>Response.json({id:crypto.randomUUID()});calls=[];await retryEmails(db,id);await deliverEmails(env,id);
assert.ok(calls.every(c=>JSON.parse(c.body).from===env.EMAIL_FROM));assert.equal(job(id).status,'sent');
console.log('PASS: definite validation rejection permits correcting sender configuration before retry.');

id=await reserve();calls=[];await Promise.all([deliverEmails(env,id),deliverEmails(env,id)]);assert.equal(calls.length,2);
console.log('PASS: concurrent queue runners claim a single job.');

const secret='whsec_'+Buffer.from('test-webhook-secret-only').toString('base64');env.RESEND_WEBHOOK_SECRET=secret;
function signed(type,emailId,createdAt=new Date(now).toISOString(),eventId=crypto.randomUUID()) {
 const body=JSON.stringify({type,created_at:createdAt,data:{email_id:emailId}}),ts=String(Math.floor(now/1000));
 const sig=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${eventId}.${ts}.${body}`).digest('base64');
 return new Request('https://test.example/api/webhooks/resend',{method:'POST',body,headers:{'svix-id':eventId,'svix-timestamp':ts,'svix-signature':'v1,'+sig}});
}
const providerId=rows(id)[0].provider_id;
const event=signed('email.delivered',providerId);assert.equal((await resendWebhook(event.clone(),env)).status,200);assert.equal((await resendWebhook(event.clone(),env)).status,200);assert.equal(sqlite.prepare('SELECT count(*) n FROM email_events').get().n,1);
const tampered=new Request(event.url,{method:'POST',headers:event.headers,body:'{}'});assert.equal((await resendWebhook(tampered,env)).status,400);
now+=301000;await assert.rejects(()=>verifyWebhook('{}',event.headers,secret));
const ctx={waitUntil:()=>{}};
assert.equal((await worker.fetch(signed('email.bounced',providerId),env,ctx)).status,200);
assert.equal((await worker.fetch(signed('email.sent',providerId),env,ctx)).status,200);
const overview=await worker.fetch(new Request('https://test.example/api/admin/overview',{headers:{authorization:'Basic '+btoa('admin:test-password')}}),env,ctx);
assert.equal(overview.status,200);const state=await overview.json();assert.equal(state.deliveries.find(d=>d.provider_id===providerId).delivery_event,'email.bounced');assert.ok(!JSON.stringify(state).includes('test-only'));assert.ok(!state.deliveries.some(d=>'payload' in d));
assert.equal((await worker.fetch(new Request('https://test.example/api/admin/overview'),env,ctx)).status,401);
assert.equal((await worker.fetch(new Request('https://test.example/api/admin/bookings/'+id+'/retry-email',{method:'POST'}),env,ctx)).status,401);
// A callback that arrives before API acceptance is retained and joins once provider_id is saved.
const early='early-provider-id';await resendWebhook(signed('email.delivered',early),env);
const earlyId=await reserve();outcome=()=>Response.json({id:early});await deliverEmails(env,earlyId);
assert.equal(sqlite.prepare('SELECT count(*) n FROM email_events e JOIN email_deliveries d ON d.provider_id=e.provider_id WHERE d.job_id=?').get(earlyId+':reserved').n,1);
console.log('PASS: signed public webhook, replay deduplication, tamper/stale rejection, out-of-order events, early callbacks, private admin records.');
globalThis.fetch=originalFetch;Date.now=realNow;
