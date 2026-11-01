// Run: node --experimental-sqlite tests/smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('schema.sql','utf8'));
sqlite.exec(fs.readFileSync('seed.sql','utf8'));
class Statement{
  constructor(sql){this.st=sqlite.prepare(sql);this.params=[];}
  bind(...params){this.params=params;return this;}
  async all(){return {results:this.st.all(...this.params)};}
  async first(){return this.st.get(...this.params)||null;}
  async run(){const o=this.st.run(...this.params);return {meta:{changes:o.changes,last_row_id:Number(o.lastInsertRowid)}};}
}
const env={DB:{prepare:s=>new Statement(s)},ASSETS:{fetch:async()=>new Response('<h1>Static</h1>')},ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password',STUDIO_TIMEZONE:'Europe/Berlin',STUDIO_NAME:'Studio Test'};
const ctx={waitUntil:p=>p.catch(console.error)};
async function req(path,method='GET',data=null,auth=false){
  const headers={};if(data)headers['content-type']='application/json';
  if(auth)headers.authorization='Basic '+btoa('admin:test-password');
  return worker.fetch(new Request('https://test.example'+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})}),env,ctx);
}
const courses=await (await req('/api/courses')).json();assert.equal(courses.courses.length,3);
const adminBlocked=await req('/api/admin/overview');assert.equal(adminBlocked.status,401);
const slots=await (await req('/api/sessions')).json();assert(slots.sessions.length>0);
const session=slots.sessions[0];
let booked=await req('/api/bookings','POST',{session_id:session.id,first_name:'Ada',last_name:'Student',email:'ada@example.org'});
assert.equal(booked.status,201,await booked.text().catch(()=>'unknown'));
let again=await req('/api/bookings','POST',{session_id:session.id,first_name:'Ada',last_name:'Student',email:'ada@example.org'});
assert.equal(again.status,409);
const admin=await (await req('/api/admin/overview','GET',null,true)).json();
assert.equal(admin.bookings.length,1);
const create=await req('/api/admin/courses','POST',{title:'Test class',description:'desc',category:'Gentle',duration_minutes:60,capacity:1,price_cents:0},true);
assert.equal(create.status,201);
const newCourse=(await create.json()).id;
const start=new Date(Date.now()+3*24*3600000);const end=new Date(start.getTime()+3600000);
const createdSession=await req('/api/admin/sessions','POST',{course_id:newCourse,starts_at:start.toISOString(),ends_at:end.toISOString()},true);
assert.equal(createdSession.status,201);
const newSessionId=(await createdSession.json()).id;
let first=await req('/api/bookings','POST',{session_id:newSessionId,first_name:'Robin',last_name:'One',email:'one@example.org'});
assert.equal(first.status,201);
let full=await req('/api/bookings','POST',{session_id:newSessionId,first_name:'Robin',last_name:'Two',email:'two@example.org'});
assert.equal(full.status,409);
const bookingId=(await first.json()).id;
let cancelled=await req(`/api/admin/bookings/${bookingId}/cancel`,'POST',{},true);
assert.equal(cancelled.status,200);
let next=await req('/api/bookings','POST',{session_id:newSessionId,first_name:'Robin',last_name:'Two',email:'two@example.org'});
assert.equal(next.status,201);
let cancelSession=await req(`/api/admin/sessions/${newSessionId}/cancel`,'POST',{},true);
assert.equal(cancelSession.status,200);
const noMore=await req('/api/bookings','POST',{session_id:newSessionId,first_name:'Robin',last_name:'Three',email:'three@example.org'});
assert.equal(noMore.status,409);
console.log('PASS: public class list, sessions, guest booking, duplicate prevention, capacity, protected admin, course/session creation, cancellation');
