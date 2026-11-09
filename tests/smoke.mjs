// Run: node --experimental-sqlite tests/smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
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
env.TURNSTILE_SECRET_KEY='test-secret';
let verification={success:true,hostname:'test.example',action:'booking'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>Response.json(verification);
const ctx={waitUntil:p=>p.catch(console.error)};
async function req(path,method='GET',data=null,auth=false){
  const headers={};if(data)headers['content-type']='application/json';
  if(auth)headers.authorization='Basic '+btoa('admin:test-password');
  return worker.fetch(new Request('https://test.example'+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})}),env,ctx);
}

const courses=(await (await req('/api/courses')).json()).courses;
assert.deepEqual(courses.map(c=>[c.duration_minutes,c.price_cents]),[[60,8000],[70,5000],[60,10000],[70,8500],[60,5000]]);
const day=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
const at=t=>day+'T'+t+':00.000Z';
const book=(course_id,t,minutes,extra={})=>req('/api/bookings','POST',{'cf-turnstile-response':'test-token',first_name:'Austin',last_name:'Guest',phone:'+1 512 555 0123',email:'guest@example.org',course_id,starts_at:at(t),minutes,...extra});
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
const first=await book(2,'17:15',70);
assert.equal(first.status,201);const id=(await first.json()).id;
assert.equal((await book(1,'17:00',60)).status,409);
assert.equal((await book(3,'18:24',60)).status,409);
assert.equal((await book(2,'17:15',70)).status,409);
assert.equal((await book(3,'18:25',60)).status,201);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{})).status,401);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,200);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,409);
assert.equal((await req('/api/admin/bookings/'+id+'/cancel','POST',{},true)).status,200);
assert.equal((await book(4,'17:15',70)).status,201);
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
  return worker.fetch(new Request('https://test.example'+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(data!==null?{body:JSON.stringify(data)}:{})}),env,ctx);
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
const payload={'cf-turnstile-response':'test-token',first_name:'Account',last_name:'User',phone:'+1 512 555 0123',email:'different@example.com',course_id:1,starts_at:at('21:00'),minutes:60,account_required:true};
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
