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
const book=(course_id,t,minutes,extra={})=>req('/api/bookings','POST',{first_name:'Austin',last_name:'Guest',phone:'+1 512 555 0123',email:'guest@example.org',course_id,starts_at:at(t),minutes,...extra});
assert.equal((await book(1,'17:00',60,{starts_at:new Date(Date.now()+3600000).toISOString()})).status,400);
assert.equal((await book(1,'17:00',60,{phone:''})).status,400);
assert.equal((await book(1,'09:00',60)).status,400);
const first=await book(2,'17:15',70);
assert.equal(first.status,201);const id=(await first.json()).id;
assert.equal((await book(1,'17:00',60)).status,409);
assert.equal((await book(3,'18:24',120)).status,409);
assert.equal((await book(2,'17:15',70)).status,409);
assert.equal((await book(3,'18:25',90)).status,201);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{})).status,401);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,200);
assert.equal((await req('/api/admin/bookings/'+id+'/paid','POST',{},true)).status,409);
assert.equal((await req('/api/admin/bookings/'+id+'/cancel','POST',{},true)).status,200);
assert.equal((await book(4,'17:15',70)).status,201);
console.log('PASS: catalog, cutoff, phone, start hours, cross-course conflict, touching intervals, protected payment action, cancellation and rebooking.');
