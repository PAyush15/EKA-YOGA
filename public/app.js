'use strict';
const $ = id => document.getElementById(id);
const zone = 'America/Chicago', dayMs = 86400000;
const dateKey = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
const dayLabel = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'short',day:'numeric',year:'numeric'});
const clock = new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
let course, selected, intervals=[], week=0;
function node(tag,text,cls){
  const n=document.createElement(tag); n.textContent=text;
  if(cls)n.className=cls;
  return n;
}
function button(text,click,cls='slot'){
  const b=node('button',text,cls); b.type='button'; b.onclick=click; return b;
}
async function api(path,options){
  const response=await fetch(path,options);
  const data=await response.json();
  if(!response.ok)throw Error(data.error || 'Please try again.');
  return data;
}
function notice(msg){$('notice').textContent=msg;$('notice').hidden=!msg;}
function step(id){
  for(const s of ['choosePrompt','dateStep','detailsStep','successStep']) $(s).hidden=s!==id;
  $('lengthBox').hidden=id!=='dateStep';
  for(const [i,key] of ['p1','p2','p3'].entries()) $(key).classList.toggle('active',i<=({choosePrompt:0,dateStep:1,detailsStep:2,successStep:2}[id]));
}
function minutes(){return Number($('duration').value==='custom'?$('minutes').value:$('duration').value);}
function startFor(day,time){
  // Austin changes offset before 07:00. UTC noon is on the same day's daytime offset.
  const offset=12-Number(clock.format(new Date(day+'T12:00:00Z')).slice(0,2));
  return Date.parse(day+'T'+time+':00Z')+offset*3600000;
}
function available(start){
  const length=minutes();
  return Number.isInteger(length)&&length>=15&&length<=360&&start>=Date.now()+2*dayMs &&
    !intervals.some(i=>start<i.end && start+length*60000>i.start);
}
function pick(day,time){
  const start=startFor(day,time);
  if(!available(start)){notice('Choose an available time and a duration of 15–360 minutes.');return;}
  selected=new Date(start).toISOString();
  $('bookingSummary').textContent=course.title+' · '+day+' · '+time+' Austin time · '+minutes()+' min · '+$('rateNote').textContent;
  $('formError').hidden=true;notice('');step('detailsStep');$('bookingForm').elements.first_name.focus();
}
function renderDays(){
  const open=$('days').querySelector('details[open]')?.dataset.day;
  $('days').replaceChildren();$('prev').disabled=week===0;
  $('customBox').hidden=$('duration').value!=='custom';
  $('rateNote').textContent=minutes()===course.duration_minutes?'$'+(course.price_cents/100).toFixed(2):'Studio will confirm the price for this duration.';
  const first=Date.parse(dateKey.format(new Date(Date.now()+2*dayMs))+'T12:00:00Z');
  for(let i=0;i<7;i++){
    const date=new Date(first+(week*7+i)*dayMs), day=date.toISOString().slice(0,10);
    const row=document.createElement('details'); row.dataset.day=day;row.open=day===open;
    row.append(node('summary',dayLabel.format(date)));
    const slots=node('div','','slots');
    for(let hour=7;hour<=19;hour++){
      const time=String(hour).padStart(2,'0')+':00';
      const b=button(time,()=>pick(day,time));b.disabled=!available(startFor(day,time));slots.append(b);
    }
    const custom=node('div','','custom-time');custom.hidden=true;
    const input=document.createElement('input');input.type='time';input.min='07:00';input.max='19:00';input.value='07:30';input.setAttribute('aria-label','Custom Austin start time');
    custom.append(input,button('Use time',()=>{if(input.value && input.reportValidity())pick(day,input.value);}));
    row.append(slots,button('Custom start time',()=>{custom.hidden=!custom.hidden;},'back-link'),custom);$('days').append(row);
  }
}
async function refresh(){intervals=(await api('/api/busy')).intervals.map(x=>({start:Date.parse(x.starts_at),end:Date.parse(x.ends_at)}));}
async function choose(c){
  try{await refresh();course=c;week=0;notice('');$('duration').replaceChildren();
    for(const m of new Set([c.duration_minutes,60,90,120,'custom'])){
      $('duration').add(new Option(({60:'1 hour',90:'1.5 hours',120:'2 hours',custom:'Custom duration'})[m]||m+' minutes',m));
    }
    $('selectedCourse').textContent=c.title;step('dateStep');renderDays();$('dateStep').scrollIntoView({block:'nearest'});
  }catch(e){notice(e.message);}
}
$('duration').onchange=renderDays;$('minutes').oninput=renderDays;
$('prev').onclick=()=>{week=Math.max(0,week-1);renderDays();};$('next').onclick=()=>{week++;renderDays();};
$('backButton').onclick=()=>{step('dateStep');renderDays();};
$('bookingForm').onsubmit=async e=>{
  e.preventDefault();$('submitBooking').disabled=true;
  try{
    const data=await api('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...Object.fromEntries(new FormData(e.target)),course_id:course.id,starts_at:selected,minutes:minutes()})});
    $('confirmationText').textContent=$('bookingSummary').textContent+' · '+data.instructions;
    $('confirmationCode').textContent='Booking reference: '+data.id;$('payment').replaceChildren();
    if(data.paymentUrl){const link=node('a','Pay for your session','hero-link');link.href=data.paymentUrl;$('payment').append(link);}
    if(data.qr){const img=new Image(160,160);img.src=data.qr;img.alt='Scan to pay';$('payment').append(img);}
    step('successStep');e.target.reset();
  }catch(err){$('formError').textContent=err.message;$('formError').hidden=false;try{await refresh();}catch{}}
  finally{$('submitBooking').disabled=false;}
};
$('bookAnother').onclick=()=>{step('choosePrompt');$('courseList').scrollIntoView();};
$('year').textContent=new Date().getFullYear();
function renderCatalog(courses) {
  const cards=courses.map(c=>{
    const card=node('article','','course-card');
    card.append(node('strong',c.title),node('p',c.description),
      node('p',c.duration_minutes+' min · $'+(c.price_cents/100).toFixed(2)),
      button('Book',()=>choose(c),'back-link'));
    return card;
  });
  $('courseList').replaceChildren(...cards);
  if(!cards.length) $('courseList').textContent='Classes will be available soon.';
}

async function loadCourses() {
  const {courses}=await api('/api/courses',{signal:AbortSignal.timeout(8000)});
  if(!Array.isArray(courses)) throw Error('Invalid catalog');
  renderCatalog(courses);
  return courses;
}

// The published catalog can be browsed even when only static files are served.
// Resolve a live course ID before opening the calendar for a reservation.
$('courseList').addEventListener('click',async event=>{
  const target=event.target.closest('[data-practice]');
  if(!target)return;
  const title=target.dataset.practice;
  target.disabled=true;
  try{
    const courses=await loadCourses();
    const match=courses.find(c=>c.title===title);
    if(match)await choose(match);
  }catch{
    $('choosePrompt').querySelector('h3').textContent=title;
    $('choosePrompt').querySelector('p').textContent='Online reservations are currently offline.';
  }finally{target.disabled=false;}
});
loadCourses().catch(()=>{}); // Keep the published cards when the live catalog cannot be reached.
api('/api/config').then(cfg=>{
  const digits=(cfg.whatsapp || '').replace(/\D/g,'');
  if(/^\d{8,15}$/.test(digits)){
    const a=$('whatsapp');a.href='https://wa.me/'+digits;a.textContent='Questions? WhatsApp +'+digits;a.hidden=false;
  }
}).catch(()=>{}); // Optional contact settings load independently of the classes.
