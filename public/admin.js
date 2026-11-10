'use strict';
const $=id=>document.getElementById(id);
const displayDate=iso=>new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Chicago',hour12:true}).format(new Date(iso));
const esc=str=>String(str??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let state={courses:[],sessions:[],bookings:[]};
function msg(message,bad=false){const box=$('adminMessage');box.textContent=message;box.className='admin-toast'+(bad?' bad':'');box.hidden=false;window.scrollTo({top:0,behavior:'smooth'});}
async function api(path,opts){
  const res=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts?.headers||{})}});
  const body=await res.json().catch(()=>({error:'Unexpected response.'}));
  if(!res.ok)throw Error(body.error||(res.status===401?'Admin access denied.':'Request failed.'));
  return body;
}
function table(headers,rows){
  return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${headers.length}">No entries yet.</td></tr>`}</tbody></table>`;
}
function render(){
  // The booking calendar generates its own start times.
  if ($('courseSelect')) $('courseSelect').innerHTML=state.courses.filter(c=>c.active).map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('');
  $('coursesTable').innerHTML=table(['Title','Length','Capacity','Price','Status','Action'],state.courses.map(c=>
    `<tr><td>${esc(c.title)}</td><td>${c.duration_minutes} min</td><td>${c.capacity}</td><td>$${(c.price_cents/100).toFixed(2)}</td><td><span class="badge ${c.active?'':'off'}">${c.active?'Published':'Hidden'}</span></td><td><button class="small-button" data-course="${c.id}" data-active="${c.active?'false':'true'}">${c.active?'Hide':'Publish'}</button></td></tr>`));
  $('sessionsTable').innerHTML=table(['Course','Date and time (Austin)','Reserved','Status','Action'],state.sessions.map(s=>
    `<tr><td>${esc(s.course_title)}</td><td>${esc(displayDate(s.starts_at))}</td><td>${s.reserved} / ${s.capacity}</td><td><span class="badge ${s.cancelled?'off':''}">${s.cancelled?'Cancelled':!s.reserved?'Open':s.paid?'Paid · Confirmed':'Reserved · Payment pending'}</span></td><td>${s.cancelled?'—':`<button class="small-button danger" data-session="${s.id}">Cancel session</button>`}</td></tr>`));
  $('bookingsTable').innerHTML=table(['Customer','Class / date','Email','Phone','Status','Email delivery','Action'],state.bookings.map(b=>
    `<tr><td>${esc(b.first_name+' '+b.last_name)}</td><td>${esc(b.course_title)}<br>${esc(displayDate(b.starts_at))}</td><td>${esc(b.email)}</td><td>${esc(b.phone)}</td><td><span class="badge ${b.status==='cancelled'?'off':''}">${b.status==='cancelled'?'Cancelled':b.paid_at?'Paid':'Payment pending'}</span></td><td>${(state.emails||[]).filter(j=>j.booking_id===b.id).map(j=>esc(j.kind+': '+j.status+(j.last_error?' ('+j.last_error+')':''))).join('<br>')||'No delivery record'}${(state.emails||[]).some(j=>j.booking_id===b.id&&['pending','failed'].includes(j.status))?'<button class="small-button" data-retry-email="'+esc(b.id)+'">Retry email</button>':''}</td><td>${b.status==='cancelled'?'—':`${b.paid_at?'':'<button class="small-button" data-paid="'+esc(b.id)+'">Mark paid</button>'}<button class="small-button danger" data-booking="${esc(b.id)}">Cancel</button>`}</td></tr>`));
}
async function refresh(){state=await api('/api/admin/overview');render();}
$('courseForm').addEventListener('submit',async e=>{
  e.preventDefault();const f=Object.fromEntries(new FormData(e.target).entries());
  const data={title:f.title,description:f.description,category:f.category,duration_minutes:Number(f.duration_minutes),capacity:Number(f.capacity),price_cents:Math.round(Number(f.price_eur)*100)};
  try{await api('/api/admin/courses',{method:'POST',body:JSON.stringify(data)});e.target.reset();await refresh();msg('Course added to the booking calendar.');}catch(err){msg(err.message,true);}
});
$('sessionForm')?.addEventListener('submit',async e=>{
  e.preventDefault();const f=Object.fromEntries(new FormData(e.target).entries());
  const start=new Date(f.starts_at),end=new Date(f.ends_at);
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())){msg('Enter valid dates.',true);return;}
  try{await api('/api/admin/sessions',{method:'POST',body:JSON.stringify({course_id:Number(f.course_id),starts_at:start.toISOString(),ends_at:end.toISOString()})});e.target.reset();await refresh();msg('New time slot is now available on the booking page.');}catch(err){msg(err.message,true);}
});
document.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-course],[data-session],[data-booking],[data-paid],[data-retry-email]');if(!btn)return;
  try{
    if(btn.dataset.retryEmail){await api('/api/admin/bookings/'+btn.dataset.retryEmail+'/retry-email',{method:'POST'});msg('Email retry queued. Refresh shortly to see delivery status.');}
    else if(btn.dataset.paid){if(!confirm('Have you verified receipt of this payment?'))return;await api('/api/admin/bookings/'+btn.dataset.paid+'/paid',{method:'POST'});msg('Payment recorded.');}
    else if(btn.dataset.course){await api(`/api/admin/courses/${btn.dataset.course}`,{method:'PATCH',body:JSON.stringify({active:btn.dataset.active==='true'})});msg('Course visibility updated.');}
    else if(btn.dataset.session){if(!confirm('Cancel this class? Existing students will NOT be automatically notified.'))return;await api(`/api/admin/sessions/${btn.dataset.session}/cancel`,{method:'POST'});msg('Session cancelled. Notify booked students manually.');}
    else if(btn.dataset.booking){if(!confirm('Cancel this reservation? The customer will NOT be automatically notified.'))return;await api(`/api/admin/bookings/${btn.dataset.booking}/cancel`,{method:'POST'});msg('Booking cancelled. Notify the customer manually.');}
    await refresh();
  }catch(err){msg(err.message,true);}
});
refresh().catch(e=>msg(`Could not load admin data: ${e.message}`,true));


