// Run: node --experimental-sqlite tests/smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
const realNow=Date.now; Date.now=()=>Date.parse('2026-11-10T22:00:00.000Z');
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('schema.sql','utf8'));

class Statement{
  constructor(sql){this.st=sqlite.prepare(sql);this.params=[];}
  bind(...params){this.params=params;return this;}
  async all(){return {results:this.st.all(...this.params)};}
  async first(){return this.st.get(...this.params)||null;}
  async run(){const o=this.st.run(...this.params);return {meta:{changes:o.changes,last_row_id:Number(o.lastInsertRowid)}};}
}
const env={DB:{prepare:s=>new Statement(s),batch:async statements=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async()=>new Response('<h1>Static</h1>')},ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password',STUDIO_TIMEZONE:'America/Chicago',STUDIO_NAME:'Studio Test'};
let batchTail=Promise.resolve();
const batch=env.DB.batch;
env.DB.batch=statements=>{const next=batchTail.then(()=>batch(statements));batchTail=next.catch(()=>{});return next;};
env.TURNSTILE_SECRET_KEY='test-secret';
let verification={success:true,hostname:'test.example',action:'booking'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>Response.json(verification);
const pending=[];
const ctx={waitUntil:p=>pending.push(p)};
async function drain(){while(pending.length)await Promise.all(pending.splice(0));}
async function req(path,method='GET',data=null,auth=false){
  const headers={};if(data)headers['content-type']='application/json';
  if(auth)headers.authorization='Basic '+btoa('admin:test-password');
  const r=await worker.fetch(new Request('https://test.example'+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})}),env,ctx);await drain();return r;
}

const courses=(await (await req('/api/courses')).json()).courses;
assert.deepEqual(courses.map(c=>[c.duration_minutes,c.price_cents]),[[60,8000],[60,5000],[60,10000],[70,8500],[60,5000]]);
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
const at=t=>day+'T'+t+':00.000Z';
const book=(course_id,t,minutes,extra={})=>req('/api/bookings','POST',{'cf-turnstile-response':'test-token',first_name:'Austin',last_name:'Guest',address_line1:'100 Example St',address_city:'Austin',address_state:'TX',address_zip:'78701',phone:'+1 512 555 0123',email:'guest@example.org',course_id,starts_at:at(t),minutes,...extra});
assert.equal((await book(1,'17:00',60,{starts_at:new Date(Date.now()+3600000).toISOString()})).status,400);
assert.equal((await book(1,'17:00',60,{phone:''})).status,400);
assert.equal((await book(1,'09:00',60)).status,400);
const before=sqlite.prepare('SELECT count(*) n FROM bookings').get().n;
assert.equal((await book(1,'17:00',60,{'cf-turnstile-response':''})).status,403);
for(const result of [{success:false},{success:true,hostname:'evil.example',action:'booking'},{success:true,hostname:'test.example',action:'login'}]){
 verification=result;assert.equal((await book(1,'17:00',60)).status,403);
}
verification={success:true,hostname:'test.example',action:'booking'};
delete env.TURNSTILE_SECRET_KEY;
assert.equal((await book(1,'17:00',60)).status,503);
env.TURNSTILE_SECRET_KEY='test-secret';
const verifyFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('network failure');};
assert.equal((await book(1,'17:00',60)).status,503);
globalThis.fetch=verifyFetch;
assert.equal(sqlite.prepare('SELECT count(*) n FROM bookings').get().n,before);
console.log('PASS: Turnstile missing token/secret, invalid token, hostname/action mismatch and network failure block reservations.');
for(const c of courses)assert.equal((await book(c.id,'17:00',c.duration_minutes+30)).status,400,'custom duration rejected');
const first=await book(2,'17:15',60);
assert.equal(first.status,201);const id=(await first.json()).id;
assert.equal((await book(1,'17:00',60)).status,409);
assert.equal((await book(3,'18:14',60)).status,409);
assert.equal((await book(2,'17:15',60)).status,409);
assert.equal((await book(3,'18:15',60)).status,201);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{})).status,401);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,200);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,409);
assert.equal((await req('/api/admin/bookings/'+id+'/cancel','POST',{},true)).status,200);
assert.equal((await book(1,'17:15',60)).status,201);
console.log('PASS: catalog, cutoff, phone, start hours, cross-course conflict, touching intervals, protected payment action, cancellation and rebooking.');

const distant=new Date(Date.now()+29*86400000);
distant.setUTCHours(18,0,0,0);
assert.equal((await book(1,'18:00',60,{starts_at:distant.toISOString()})).status,400);
env.ADMIN_PASSWORD='test-password:with-colon';
const authorized=await worker.fetch(new Request('https://test.example/api/admin/overview',{headers:{authorization:'Basic '+btoa('admin:'+env.ADMIN_PASSWORD)}}),env,ctx);
assert.equal(authorized.status,200);
console.log('PASS: four-week advance limit and colon-containing admin password.');
for (const [body,status] of [['null',400],['['+' '.repeat(9000)+']',413]]) {
  const r=await worker.fetch(new Request('https://test.example/api/bookings',{method:'POST',body}),env,ctx);
  assert.equal(r.status,status);
}
console.log('PASS: malformed and oversized booking bodies rejected.');


// Real RSA signatures exercise server verification; no Google network/account needed.
const {hash}=await import('../src/auth.js');
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='test-key';jwk.use='sig';
const savedFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
  if(String(url).includes('/turnstile/'))return savedFetch(url,options);
  assert.equal(String(url),'https://www.googleapis.com/oauth2/v3/certs');
  return Response.json({keys:[jwk]});
};
env.GOOGLE_CLIENT_ID='test-client.apps.googleusercontent.com';
async function customerReq(path,method='GET',data=null,cookie='',origin='https://test.example') {
  const r=await worker.fetch(new Request('https://test.example'+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(data!==null?{body:JSON.stringify(data)}:{})}),env,ctx);await drain();return r;
}
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function credential(nonce,overrides={}){
  const unsigned=b64({alg:'RS256',kid:'test-key'})+'.'+b64({sub:'google-user-1',email:'account@gmail.com',email_verified:true,name:'Account User',aud:env.GOOGLE_CLIENT_ID,iss:'https://accounts.google.com',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,nonce,...overrides});
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned));
  return unsigned+'.'+Buffer.from(signature).toString('base64url');
}
assert.equal((await customerReq('/api/me/bookings')).status,401);
assert.equal((await customerReq('/api/auth/nonce','POST',{},'','https://evil.example')).status,403);
const nonceResponse=await customerReq('/api/auth/nonce','POST',{});
const nonce=(await nonceResponse.json()).nonce;
const nonceCookie=nonceResponse.headers.get('set-cookie').split(';')[0];
assert.match(nonceResponse.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
for(const override of [{aud:'evil-client'},{exp:1},{nonce:'wrong'},{email_verified:false},{iss:'https://evil.example'}]){
  assert.equal((await customerReq('/api/auth/google','POST',{credential:await credential(nonce,override)},nonceCookie)).status,401);
}
const valid=await credential(nonce);
const tampered=valid.split('.');tampered[1]=b64({email:'stolen@example.com'});
assert.equal((await customerReq('/api/auth/google','POST',{credential:tampered.join('.')},nonceCookie)).status,401);
const login=await customerReq('/api/auth/google','POST',{credential:valid},nonceCookie);
assert.equal(login.status,200);
const sessionCookie=login.headers.getSetCookie().find(c=>c.startsWith('__Host-yoga_session=')).split(';')[0];
assert.equal((await customerReq('/api/auth/google','POST',{credential:valid},nonceCookie)).status,401,'nonce cannot be reused');
assert.equal((await (await customerReq('/api/auth/me','GET',null,sessionCookie)).json()).user.email,'account@gmail.com');
assert.equal((await (await customerReq('/api/me/bookings','GET',null,sessionCookie)).json()).bookings.length,0,'guest bookings remain private');
const payload={'cf-turnstile-response':'test-token',first_name:'Account',last_name:'User',address_line1:'100 Example St',address_city:'Austin',address_state:'TX',address_zip:'78701',phone:'+1 512 555 0123',email:'different@example.com',course_id:1,starts_at:at('21:00'),minutes:60,account_required:true};
assert.equal((await customerReq('/api/bookings','POST',payload)).status,401,'expired sign-in must not silently become guest');
const reserved=await customerReq('/api/bookings','POST',payload,sessionCookie);
assert.equal(reserved.status,201);
const bookingId=(await reserved.json()).id;
assert.equal(sqlite.prepare('SELECT email FROM bookings WHERE id=?').get(bookingId).email,'account@gmail.com');
let mine=(await (await customerReq('/api/me/bookings','GET',null,sessionCookie)).json()).bookings;
assert.equal(mine.length,1);assert.equal(mine[0].id,bookingId);assert.equal(mine[0].paid_at,null);
sqlite.prepare('INSERT INTO customers(id,email,name) VALUES(?,?,?)').run('other','account@gmail.com','Other User');
const otherToken='a'.repeat(64);
sqlite.prepare('INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(?,?,?)').run(await hash(otherToken),'other',Math.floor(Date.now()/1000)+3600);
assert.equal((await (await customerReq('/api/me/bookings','GET',null,'__Host-yoga_session='+otherToken)).json()).bookings.length,0,'same email does not grant another account access');
sqlite.prepare('INSERT INTO payments(booking_id,paid_at) VALUES(?,?)').run(bookingId,new Date().toISOString());
mine=(await (await customerReq('/api/me/bookings','GET',null,sessionCookie)).json()).bookings;assert.ok(mine[0].paid_at);
sqlite.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bookingId);
assert.equal((await (await customerReq('/api/me/bookings','GET',null,sessionCookie)).json()).bookings[0].status,'cancelled');
assert.equal((await customerReq('/api/auth/logout','POST',{},sessionCookie)).status,200);
assert.equal((await customerReq('/api/me/bookings','GET',null,sessionCookie)).status,401);
sqlite.prepare('UPDATE customer_sessions SET expires_at=1 WHERE customer_id=?').run('other');
assert.equal((await customerReq('/api/me/bookings','GET',null,'__Host-yoga_session='+otherToken)).status,401);
globalThis.fetch=savedFetch;
console.log('PASS: signed Google tokens, claim/signature rejection, CSRF, nonce replay, secure cookies, booking ownership, account isolation, payment/cancellation status, logout and expiration.');

globalThis.fetch=originalFetch;

// Use Austin's local weekday and offset, including DST, for weekend exclusions.
for(let offset=3;offset<=9;offset++){
 const date=new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
 const weekday=new Date(date+'T12:00:00Z').getUTCDay();
 const noonHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Chicago',hour:'2-digit',hourCycle:'h23'}).format(new Date(date+'T12:00:00Z')));
 for(const time of ['14:00','17:30']){
  const start=new Date(Date.parse(date+'T'+time+':00Z')+(12-noonHour)*3600000).toISOString();
  const response=await book(1,'17:00',60,{starts_at:start,'cf-turnstile-response':''});
  assert.equal(response.status,(weekday===0||weekday===6)?400:403);
 }
}
console.log('PASS: Saturday/Sunday excluded starts blocked; weekday starts reach verification.');

const {bookableStart,bookingWindow,withinHours}=await import('../public/booking-rules.js');
assert.deepEqual(bookingWindow(),{first:'2026-11-13',last:'2026-12-08'});
for(const [start,status] of [
 ['2026-11-12T16:00:00.000Z',400], // Thursday
 ['2026-11-13T14:00:00.000Z',403], // Friday 8 AM, under 72 elapsed hours
 ['2026-11-13T13:59:00.000Z',400],
 ['2026-11-14T00:30:00.000Z',403], // Friday 6:30 PM
 ['2026-11-14T00:31:00.000Z',400],
 ['2026-11-14T18:00:00.000Z',403], // Saturday noon
 ['2026-11-14T18:01:00.000Z',400],
 ['2026-11-15T14:00:00.000Z',403], // Sunday 8 AM
 ['2026-11-15T20:00:00.000Z',400],
 ['2026-12-09T00:30:00.000Z',403], // Last day in Austin, Dec 8
 ['2026-12-09T14:00:00.000Z',400]
]) {
 assert.equal(bookableStart(Date.parse(start)),status===403,start);
 assert.equal((await book(1,'17:00',60,{starts_at:start,'cf-turnstile-response':''})).status,status,start);
}
assert.deepEqual(bookingWindow(Date.parse('2026-11-11T05:59:00Z')),{first:'2026-11-13',last:'2026-12-08'});
assert.deepEqual(bookingWindow(Date.parse('2026-11-11T06:00:00Z')),{first:'2026-11-14',last:'2026-12-09'});
assert.equal(bookingWindow(Date.parse('2026-12-31T22:00:00Z')).first,'2027-01-03');
assert.equal(bookableStart(Date.parse('2027-03-14T13:00:00Z'),Date.parse('2027-03-11T22:00:00Z')),true,'DST start: Sunday 8 AM');
assert.equal(bookableStart(Date.parse('2027-11-07T14:00:00Z'),Date.parse('2027-11-04T21:00:00Z')),true,'DST end: Sunday 8 AM');
console.log('PASS: three Austin calendar days, earliest morning, midnight rollover, month/year rollover, DST, weekday/weekend hours and 28-day limit.');
// Test both email recipients without sending external mail.
const vm=await import('node:vm');
const sent=[];
const props={NOTIFY_SHARED_SECRET:'test-secret',ADMIN_EMAIL:'owner@example.org'};
const context={PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key],getProperties:()=>({...props}),setProperty:(k,v)=>props[k]=v,deleteProperty:k=>delete props[k]})},LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock:()=>{}})},Utilities:{formatDate:()=> 'Mon, Nov 16, 1:00 PM CST'},MailApp:{sendEmail:message=>sent.push(message)},ContentService:{createTextOutput:text=>text},console};
vm.createContext(context);
vm.runInContext(fs.readFileSync('google-apps-script/Code.gs','utf8'),context);
const notification={secret:'test-secret',id:'11111111-1111-4111-8111-111111111111',firstName:'Test',lastName:'Customer',email:'customer@example.org',phone:'+1 512 555 0123',course:'Private yoga',startsAt:'2026-11-16T19:00:00.000Z',duration:60,instructions:'Payment pending'};
assert.equal(context.doPost({postData:{contents:JSON.stringify(notification)}}),'OK');
assert.deepEqual(sent.map(m=>m.to),['customer@example.org','owner@example.org']);
assert.ok(sent[1].body.includes(notification.id) && sent[1].body.includes(notification.phone));
sent.length=0;
context.doPost({postData:{contents:JSON.stringify({...notification,secret:'wrong'})}});
assert.equal(sent.length,0);
console.log('PASS: email script addresses customer and administrator, includes booking info, and rejects an invalid secret.');

assert.equal(context.doPost({postData:{contents:JSON.stringify(notification)}}),'OK');
assert.equal(sent.length,0,'same event must not send twice');
assert.equal(context.doPost({postData:{contents:JSON.stringify({...notification,paid:true})}}),'OK');
assert.equal(sent.length,2,'paid event sends customer and owner');
assert.ok(sent[0].subject.includes('confirmed'));assert.ok(sent[0].body.includes('60 minutes'));
sent.length=0;
const second={...notification,id:'22222222-2222-4222-8222-222222222222'};
context.MailApp.sendEmail=m=>{if(m.to==='customer@example.org')throw Error('quota');sent.push(m);};
assert.equal(context.doPost({postData:{contents:JSON.stringify(second)}}),'ERROR');
assert.deepEqual(sent.map(m=>m.to),['owner@example.org'],'attempt owner when customer fails');
sent.length=0;context.MailApp.sendEmail=m=>sent.push(m);
assert.equal(context.doPost({postData:{contents:JSON.stringify(second)}}),'OK');
assert.deepEqual(sent.map(m=>m.to),['customer@example.org'],'retry only failed recipient');
console.log('PASS: pending/paid email content, duplicate suppression, partial failure and per-recipient retry.');

const {deliverEmails}=await import('../src/notifications.js');
env.NOTIFY_WEBHOOK_URL='https://script.google.com/macros/s/test/exec';env.NOTIFY_SHARED_SECRET='test-secret';
// Exercise actual Worker -> webhook payload -> Apps Script handler; all email delivery is mocked.
const webhookPayloads=[];
globalThis.fetch=async(url,options)=>{
 if(String(url).includes('/turnstile/'))return Response.json(verification);
 assert.equal(String(url),env.NOTIFY_WEBHOOK_URL);
 const payload=JSON.parse(options.body);webhookPayloads.push(payload);
 return new Response(context.doPost({postData:{contents:options.body}}));
};
const liveBook=await book(1,'16:00',60,{starts_at:'2026-11-16T16:00:00.000Z'});
assert.equal(liveBook.status,201);const liveId=(await liveBook.json()).id;
assert.equal(webhookPayloads.at(-1).startsAt,'2026-11-16T16:00:00.000Z');
assert.equal(webhookPayloads.at(-1).duration,60);
assert.equal(sqlite.prepare('SELECT status FROM email_jobs WHERE booking_id=?').get(liveId).status,'sent');
const busy=(await (await req('/api/busy')).json()).intervals;
assert.ok(busy.some(i=>i.starts_at==='2026-11-16T16:00:00.000Z'&&i.ends_at==='2026-11-16T17:00:00.000Z'));
assert.ok(busy.every(i=>Object.keys(i).sort().join(',')==='ends_at,starts_at'),'no customer data in public availability');
assert.equal((await book(4,'16:00',70,{starts_at:'2026-11-16T16:30:00.000Z'})).status,409);
assert.equal(webhookPayloads.length,1,'no email for rejected overlap');
globalThis.fetch=async(url,options)=>String(url).includes('/turnstile/')?Response.json(verification):new Response('ERROR');
const failedBook=await book(1,'16:00',60,{starts_at:'2026-11-17T16:00:00.000Z'});
assert.equal(failedBook.status,201);const failedId=(await failedBook.json()).id;
assert.equal(sqlite.prepare('SELECT status FROM email_jobs WHERE booking_id=?').get(failedId).status,'pending');
assert.equal((await book(1,'16:00',60,{starts_at:'2026-11-17T16:00:00.000Z'})).status,409,'mail failure does not release reservation');
globalThis.fetch=async(url)=>String(url).includes('/turnstile/')?Response.json(verification):new Response('OK');
sqlite.prepare('UPDATE email_jobs SET next_attempt=0 WHERE booking_id=?').run(failedId);
await deliverEmails(env,failedId);
assert.equal(sqlite.prepare('SELECT status FROM email_jobs WHERE booking_id=?').get(failedId).status,'sent');
assert.equal((await req('/api/admin/bookings/'+failedId+'/retry-email','POST',{})).status,401);
const simultaneous=await Promise.all([1,3,4].map(course_id=>book(course_id,'16:00',course_id===4?70:60,{starts_at:'2026-11-18T16:00:00.000Z'})));
assert.deepEqual(simultaneous.map(r=>r.status).sort(),[201,409,409],'only one concurrent request reserves an interval');
assert.equal((await book(1,'16:00',60,{starts_at:'2026-11-19T16:00:00.000Z',email:'a@example.org,b@example.org'})).status,400,'reject multiple recipient addresses');
// Password was changed earlier; verify private overview with the current password separately.
const overview=await worker.fetch(new Request('https://test.example/api/admin/overview',{headers:{authorization:'Basic '+btoa('admin:'+env.ADMIN_PASSWORD)}}),env,ctx);
assert.equal(overview.status,200);assert.ok((await overview.json()).emails.some(j=>j.booking_id===failedId&&j.status==='sent'));
console.log('PASS: concurrent same-slot requests, single-recipient email validation and private delivery status.');
console.log('PASS: end-to-end notification payload, queued failures/retry, persisted slot blocking, public-data privacy and protected retry.');
const {PAYMENT_METHODS,paymentMethods,paymentInstructions}=await import('../src/payment-config.js');
assert.deepEqual(paymentMethods(),[],'unset methods hidden');
PAYMENT_METHODS[0].recipient='+1 512 555 0100';PAYMENT_METHODS[0].qrPath='/payments/zelle-qr.png';
PAYMENT_METHODS[1].recipient='@test-tag';PAYMENT_METHODS[1].url='https://venmo.com/test-tag';
assert.equal(paymentMethods().length,2);
assert.match(paymentInstructions(5000,paymentMethods()),/Total: \$50.00/);
assert.match(paymentInstructions(5000,paymentMethods()),/@test-tag/);
PAYMENT_METHODS[1].url='javascript:alert(1)';PAYMENT_METHODS[0].qrPath='/payments/../../private';
assert.equal(paymentMethods()[1].url,'');assert.equal(paymentMethods()[0].qr,'');
for(const m of PAYMENT_METHODS){m.recipient='';m.url='';m.qrPath='';}
console.log('PASS: Zelle/Venmo config, totals, blank defaults, unsafe URL/path rejection.');
globalThis.fetch=originalFetch;Date.now=realNow;
