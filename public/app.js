'use strict';
const el = id => document.getElementById(id);
const state = { courses: [], sessions: [], course: null, day: null, session: null, demo: false,
  timezone: 'Europe/Berlin', studioName: 'Soma Yoga Studio', month: null };
const now = new Date();
el('year').textContent = now.getFullYear();
const timeText = iso => new Intl.DateTimeFormat('en-GB', {timeZone: state.timezone, hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(iso));
const dateText = iso => new Intl.DateTimeFormat('en-GB', {timeZone: state.timezone, weekday:'long', day:'numeric',month:'long',year:'numeric'}).format(new Date(iso));
const dateParts = iso => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: state.timezone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(iso)).filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
const dayKey = iso => { const p = dateParts(iso); return `${p.year}-${p.month}-${p.day}`; };
const formatPrice = course => !course.price_cents ? 'Free' : new Intl.NumberFormat('en', {style:'currency',currency:course.currency || 'EUR',maximumFractionDigits:2}).format(course.price_cents/100);
function demoData() {
  state.demo = true;
  state.courses = [
    {id:1,title:'Morning Hatha Flow',description:'Mindful movement, breathwork and grounded poses. All levels welcome.',category:'Gentle',duration_minutes:70,capacity:10,price_cents:1500,currency:'EUR'},
    {id:2,title:'Vinyasa & Energy',description:'A dynamic, energizing flow that builds strength and focus.',category:'Dynamic',duration_minutes:60,capacity:12,price_cents:1800,currency:'EUR'},
    {id:3,title:'Yin & Deep Rest',description:'Slow restorative stretches, quiet breathing and complete release.',category:'Restorative',duration_minutes:75,capacity:8,price_cents:1400,currency:'EUR'}
  ];
  state.sessions = [];
  for(let offset=1;offset<44;offset++){
    const d = new Date(Date.now() + offset*86400000);
    const w=d.getDay(); const id=w===2?1:w===4?2:w===6?3:null;
    if(!id)continue;
    d.setHours(id===1?9:id===2?18:10,0,0,0);
    state.sessions.push({id:offset,course_id:id,starts_at:d.toISOString(),remaining:id===3?5:9});
  }
  showNotice('Preview mode — the design works, but reservations require a deployed database and API.');
}
function showNotice(message) {el('notice').textContent=message;el('notice').hidden=false;}
function renderCourses(){
  el('courseList').innerHTML='';
  if(!state.courses.length){el('courseList').textContent='No classes published yet.';return;}
  for(const c of state.courses){
    const button=document.createElement('button');button.className='course-card'+(state.course?.id===c.id?' active':'');button.type='button';
    const category=document.createElement('span');category.className='category';category.textContent=c.category;
    const title=document.createElement('strong');title.textContent=c.title;
    const desc=document.createElement('p');desc.textContent=c.description;
    const meta=document.createElement('div');meta.className='course-tags';
    for(const v of [`${c.duration_minutes} min`,`${c.capacity} spots`,formatPrice(c)]){const tag=document.createElement('span');tag.textContent=v;meta.append(tag);}
    button.append(category,title,desc,meta);button.addEventListener('click',()=>selectCourse(c.id));el('courseList').append(button);
  }
}
function selectCourse(id){
  state.course=state.courses.find(c=>c.id===id);state.day=null;state.session=null;
  const today=dayKey(new Date().toISOString());state.month=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7))-1,1));
  el('choosePrompt').hidden=true;el('dateStep').hidden=false;el('detailsStep').hidden=true;el('successStep').hidden=true;
  el('selectedCourse').innerHTML='';
  const name=document.createElement('strong');name.textContent=state.course.title;
  const meta=document.createElement('small');meta.textContent=`${state.course.duration_minutes} minutes · ${formatPrice(state.course)} · Up to ${state.course.capacity} students`;
  el('selectedCourse').append(name,meta);
  renderCourses();renderCalendar();renderTimes();setProgress(2);document.querySelector('.booking-panel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function setProgress(step){ for(let i=1;i<=3;i++){el('p'+i).className='progress-step'+(step===i?' active':step>i?' done':'');} }
function availableSessions(day){return state.sessions.filter(s=>s.course_id===state.course?.id && s.remaining>0 && dayKey(s.starts_at)===day && new Date(s.starts_at)>new Date());}
function renderCalendar(){
  const year=state.month.getUTCFullYear(), month=state.month.getUTCMonth();
  const monthStr=new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(state.month);
  el('monthLabel').textContent=monthStr;
  const todayKey=dayKey(new Date().toISOString());
  const currentMonth=new Date(Date.UTC(Number(todayKey.slice(0,4)),Number(todayKey.slice(5,7))-1,1));
  el('prevMonth').disabled=state.month<=currentMonth;
  el('nextMonth').disabled=state.month>=new Date(Date.UTC(currentMonth.getUTCFullYear(),currentMonth.getUTCMonth()+2,1));
  const cal=el('calendar');cal.innerHTML='';
  for(const d of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']){const h=document.createElement('span');h.className='dow';h.textContent=d;cal.append(h);}
  const offset=(new Date(Date.UTC(year,month,1)).getUTCDay()+6)%7;
  for(let j=0;j<offset;j++)cal.append(document.createElement('span'));
  const count=new Date(Date.UTC(year,month+1,0)).getUTCDate();
  for(let date=1;date<=count;date++){
    const key=`${year}-${String(month+1).padStart(2,'0')}-${String(date).padStart(2,'0')}`;
    const n=availableSessions(key).length;
    const b=document.createElement('button');b.type='button';b.className='cal-day'+(n?' is-available':'')+(state.day===key?' selected':'');
    b.textContent=date;b.disabled=!n;b.setAttribute('aria-label',`${key}${n?' available':''}`);
    if(n)b.addEventListener('click',()=>{state.day=key;state.session=null;renderCalendar();renderTimes();});
    cal.append(b);
  }
}
function renderTimes(){
  el('timezoneLabel').textContent=state.timezone.replace('_',' ');
  const target=el('timeList');target.innerHTML='';
  if(!state.day){const m=document.createElement('span');m.className='muted';m.textContent='Select a highlighted date to see times.';target.append(m);return;}
  const times=availableSessions(state.day).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  if(!times.length){target.textContent='No remaining times. Select a different day.';return;}
  times.forEach(s=>{
    const b=document.createElement('button');b.className='time-slot';b.type='button';
    b.textContent=timeText(s.starts_at);const small=document.createElement('small');small.textContent=`${s.remaining} spot${s.remaining!==1?'s':''} left`;
    b.append(small);b.addEventListener('click',()=>selectSession(s));target.append(b);
  });
}
function selectSession(session){
  state.session=session;setProgress(3);el('dateStep').hidden=true;el('detailsStep').hidden=false;
  el('bookingSummary').innerHTML='';const strong=document.createElement('strong');strong.textContent=state.course.title;
  const p=document.createElement('p');p.textContent=`${dateText(session.starts_at)} at ${timeText(session.starts_at)} · ${state.course.duration_minutes} min · ${formatPrice(state.course)}`;
  el('bookingSummary').append(strong,p);el('formError').hidden=true;
  el('bookingForm').reset();
}
el('backButton').addEventListener('click',()=>{el('detailsStep').hidden=true;el('dateStep').hidden=false;setProgress(2);});
el('prevMonth').addEventListener('click',()=>{state.month=new Date(Date.UTC(state.month.getUTCFullYear(),state.month.getUTCMonth()-1,1));renderCalendar();});
el('nextMonth').addEventListener('click',()=>{state.month=new Date(Date.UTC(state.month.getUTCFullYear(),state.month.getUTCMonth()+1,1));renderCalendar();});
el('bookAnother').addEventListener('click',()=>selectCourse(state.course.id));
el('bookingForm').addEventListener('submit',async event=>{
  event.preventDefault();const error=el('formError');error.hidden=true;
  if(state.demo){error.textContent='Preview mode does not save reservations. Deploy the backend first.';error.hidden=false;return;}
  const button=el('submitBooking');button.disabled=true;button.firstChild.textContent='Confirming… ';
  const data=Object.fromEntries(new FormData(event.currentTarget).entries());data.session_id=state.session.id;
  try{
    const r=await fetch('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    const body=await r.json();if(!r.ok)throw new Error(body.error || 'Booking failed.');
    el('detailsStep').hidden=true;el('successStep').hidden=false;setProgress(3);
    el('confirmationText').textContent=`Your place in ${body.course} on ${dateText(body.starts_at)} at ${timeText(body.starts_at)} is reserved. ${body.email} will receive an email if notifications are configured.`;
    el('confirmationCode').textContent='Reference: '+body.id.slice(0,8).toUpperCase();
    await loadSessions();
  }catch(e){error.textContent=e.message;error.hidden=false;}
  finally{button.disabled=false;button.firstChild.textContent='Confirm reservation ';}
});
async function loadSessions(){
  const start=new Date(Date.now()-86400000).toISOString();const end=new Date(Date.now()+65*86400000).toISOString();
  const r=await fetch(`/api/sessions?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  if(!r.ok)throw new Error('Cannot load class dates.');state.sessions=(await r.json()).sessions;
  if(state.course) {renderCalendar();renderTimes();}
}
(async()=>{
  try{
    const [c,s]=await Promise.all([fetch('/api/config'),fetch('/api/courses')]);
    if(!c.ok||!s.ok)throw new Error('API unavailable.');
    const config=await c.json();state.studioName=config.studioName||state.studioName;state.timezone=config.timezone||state.timezone;
    state.courses=(await s.json()).courses;await loadSessions();
  }catch(e){demoData();}
  document.title=`Book a Class • ${state.studioName}`;
  el('footerStudio').textContent=state.studioName;
  el('brandName').textContent=state.studioName.split(' ')[0].toLowerCase();
  renderCourses();
})();
