'use strict';
const $ = id => document.getElementById(id);
const zone = 'America/Chicago', dayMs = 86400000;
const dateKey = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
const dayLabel = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'short',day:'numeric',year:'numeric'});
const clock = new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
let live=false, selection=0, catalog=[];
let securityWidget, securityLoading, securityToken='';
function resetSecurity(){
  securityToken='';
  if(securityWidget!==undefined && window.turnstile)window.turnstile.reset(securityWidget);
}
async function prepareSecurity(){
  if(pagesPreview)return;
  $('retrySecurity').hidden=true;
  $('securityMessage').textContent='Loading security check…';
  try {
    if(!window.turnstile){
      if(!securityLoading)securityLoading=new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async=true;
        const timer=setTimeout(()=>{script.remove();reject(Error());},15000);
        script.onload=()=>{clearTimeout(timer);resolve();};
        script.onerror=()=>{clearTimeout(timer);script.remove();reject(Error());};
        document.head.append(script);
      }).catch(e=>{securityLoading=null;throw e;});
      await securityLoading;
    }
    if(securityWidget!==undefined){resetSecurity();return;}
    securityWidget=window.turnstile.render('#bookingSecurity',{
      sitekey:'0x4AAAAAAF2faBhtFauaoAiT',action:'booking',
      callback:token=>{securityToken=token;$('securityMessage').textContent='Security check complete.';},
      'expired-callback':()=>{securityToken='';$('securityMessage').textContent='Please complete the security check again.';},
      'error-callback':()=>{securityToken='';$('securityMessage').textContent='Security check could not load. Please retry.';$('retrySecurity').hidden=false;}
    });
  }catch{$('securityMessage').textContent='Security check could not load. Please retry.';$('retrySecurity').hidden=false;}
}
$('retrySecurity').onclick=prepareSecurity;
const pagesPreview=location.hostname.endsWith('.github.io') || location.protocol==='file:';
let course, selected, chosenDay, chosenTime, intervals=[], week=0;
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
function sessionPrice(c){
  const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0}).format(c.price_cents/100);
  if(c.title==='Small Group Yoga')return amount+' total for 1–5 people';
  if(c.title==='Group Yoga Session')return amount+' total for 1–10 people';
  return amount;
}
function minutes(){return course.duration_minutes;}
function timeLabel(time){const [h,m]=time.split(':').map(Number);return (h%12||12)+':'+String(m).padStart(2,'0')+' '+(h<12?'AM':'PM');}
function startFor(day,time){
  // Austin changes offset before 07:00. UTC noon is on the same day's daytime offset.
  const offset=12-Number(clock.format(new Date(day+'T12:00:00Z')).slice(0,2));
  return Date.parse(day+'T'+time+':00Z')+offset*3600000;
}
function weekendBlocked(start){
  const day=dateKey.format(new Date(start));
  const weekday=new Date(day+'T12:00:00Z').getUTCDay();
  return (weekday===0||weekday===6)&&['14:00','17:30'].includes(clock.format(new Date(start)));
}
function available(start){
  const length=minutes();
  if(weekendBlocked(start))return false;
  return Number.isInteger(length)&&length>=15&&length<=360&&(live || pagesPreview) && start>=Date.now()+2*3600000 && start<=Date.now()+28*dayMs &&
    !intervals.some(i=>start<i.end && start+length*60000>i.start);
}
function pick(day,time){
  const start=startFor(day,time);
  if(!available(start)){notice('Choose an available time.');return;}
  selected=new Date(start).toISOString();chosenDay=day;chosenTime=time;
  renderDays();
  $('lengthBox').scrollIntoView({block:'nearest'});
}
$('continueTime').onclick=async()=>{
  if(live){try{await refresh();}catch{notice('Could not verify availability. Please try again.');return;}}
  if(!selected || !available(Date.parse(selected))){notice('Choose an available date and time.');return;}
  $('bookingSummary').textContent=course.title+' · '+chosenDay+' · '+timeLabel(chosenTime)+' Austin time · '+minutes()+' min · '+$('rateNote').textContent;
  $('formError').hidden=true;notice('');step('detailsStep');$('bookingForm').hidden=false;
  $('previewDetails').hidden=live;
  $('submitBooking').textContent=pagesPreview?'Continue to sample payment →':'Confirm reservation →';
  window.prefillAccount?.();prepareSecurity();
  $('bookingForm').elements.first_name.focus();
};

function renderDays(){
  if(selected && !available(Date.parse(selected))){selected=null;chosenDay=null;chosenTime=null;}
  $('selectedTime').textContent=selected?chosenDay+' · '+timeLabel(chosenTime)+' Austin time · '+minutes()+' min':'Select a time above.';
  $('continueTime').disabled=!selected;
  const open=$('days').querySelector('details[open]')?.dataset.day;
  $('days').replaceChildren();$('next').hidden=week>=3;
  $('fixedDuration').textContent=minutes()+' minutes';
  $('rateNote').textContent=sessionPrice(course);
  const first=Date.parse(dateKey.format(new Date(Date.now()+2*3600000))+'T12:00:00Z');
  for(let i=0;i<7*(week+1);i++){
    const date=new Date(first+i*dayMs), day=date.toISOString().slice(0,10);
    if(day>dateKey.format(new Date(Date.now()+28*dayMs)))break;
    const row=document.createElement('details'); row.dataset.day=day;row.open=open ? day===open : i===0;
    row.append(node('summary',dayLabel.format(date)));
    const slots=node('div','','slots');
    for(const time of ['08:00','10:00','14:00','17:30']){
      if(!available(startFor(day,time)))continue;
      const b=button(timeLabel(time),()=>pick(day,time));b.disabled=!available(startFor(day,time));b.classList.toggle('selected',chosenDay===day && chosenTime===time);b.setAttribute('aria-pressed',String(chosenDay===day && chosenTime===time));slots.append(b);
    }
    if(!slots.children.length)slots.append(node('p','No preset times available. Try another date or a custom time.','muted'));
    const custom=node('div','','custom-time');custom.hidden=true;
    const hour=document.createElement('select'),minute=document.createElement('select'),period=document.createElement('select');
    hour.setAttribute('aria-label','Custom start hour');minute.setAttribute('aria-label','Custom start minute');period.setAttribute('aria-label','AM or PM');
    for(let h=1;h<=12;h++)hour.add(new Option(String(h),h));
    for(let m=0;m<60;m++)minute.add(new Option(String(m).padStart(2,'0'),m));
    for(const p of ['AM','PM'])period.add(new Option(p,p));
    hour.value='7';minute.value='30';
    const timeRow=node('div','','custom-time-row');
    const colon=node('span',':','time-colon');colon.setAttribute('aria-hidden','true');
    timeRow.append(hour,colon,minute,period);
    custom.append(timeRow,node('p','Choose a start time from 7:00 AM to 7:00 PM. Weekend starts at 2:00 PM and 5:30 PM are unavailable.'),button('Use time',()=>{
      const h=Number(hour.value)%12+(period.value==='PM'?12:0),m=Number(minute.value);
      if(h<7||h>19||(h===19&&m>0)){notice('Choose a start time from 7:00 AM to 7:00 PM.');return;}
      notice('');pick(day,String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'));
    }));
    custom.id='custom-time-'+day;
    const customButton=button('Choose a custom time +',()=>{
      custom.hidden=!custom.hidden;
      customButton.setAttribute('aria-expanded',String(!custom.hidden));
      customButton.textContent=custom.hidden?'Choose a custom time +':'Hide custom time −';
    },'custom-time-toggle');
    customButton.setAttribute('aria-expanded','false');
    customButton.setAttribute('aria-controls',custom.id);
    row.append(slots,customButton,custom);$('days').append(row);
  }
}
async function refresh(){intervals=(await api('/api/busy')).intervals.map(x=>({start:Date.parse(x.starts_at),end:Date.parse(x.ends_at)}));}
async function choose(c){
  const token=++selection;
  course=c;selected=null;chosenDay=null;chosenTime=null;week=0;live=false;intervals=[];notice('');
  $('selectedCourse').textContent=c.title;
  step('dateStep');renderDays();
  $('dateStep').scrollIntoView({block:'start'});
  $('availabilityNote').textContent=pagesPreview?'Choose a time to try the booking demo.':'Checking studio availability…';
  if(pagesPreview)return;
  try{
    const courses=catalog.length?catalog:await loadCourses();
    const match=courses.find(item=>c.id ? item.id===c.id : item.title===c.title);
    const {intervals:busy}=await api('/api/busy',{signal:AbortSignal.timeout(8000)});
    if(token!==selection)return;
    if(!match)throw Error('Course unavailable');
    course=match;intervals=busy.map(x=>({start:Date.parse(x.starts_at),end:Date.parse(x.ends_at)}));
    live=true;$('availabilityNote').textContent='';
    renderDays();
    if(!$('detailsStep').hidden){step('dateStep');}
  }catch{if(token===selection)$('availabilityNote').textContent='Preview times · Live availability could not be verified.';}
}
$('next').onclick=()=>{const added=$('days').children.length;week=Math.min(3,week+1);renderDays();$('days').children[added]?.querySelector('summary')?.focus();};
$('backButton').onclick=async()=>{if(live){try{await refresh();}catch{notice('Could not refresh availability.');}}step('dateStep');renderDays();};
$('bookingForm').onsubmit=async e=>{
  e.preventDefault();if(pagesPreview){
    $('resultTitle').textContent='Sample payment';
    $('confirmationText').textContent=$('bookingSummary').textContent;
    $('confirmationCode').textContent='Demo checkout · No reservation or charge.';
    const link=node('a','Open sample link (YouTube) ↗','hero-link');
    link.href='https://www.youtube.com/';link.target='_blank';link.rel='noopener noreferrer';
    const qr=new Image(168,168);qr.src='./sample-checkout.svg';qr.alt='QR code for the sample YouTube link';
    $('payment').replaceChildren(qr,link);
    e.target.reset();step('successStep');$('successStep').scrollIntoView({block:'start'});return;
  }
  if(!live)return;
  if(!selected || !available(Date.parse(selected))){$('formError').textContent='Please choose a new time at least two hours from now.';$('formError').hidden=false;return;}
  if(!securityToken){$('formError').textContent='Please complete the security check before booking.';$('formError').hidden=false;return;}
  $('submitBooking').disabled=true;
  try{
    const data=await api('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...Object.fromEntries(new FormData(e.target)),'cf-turnstile-response':securityToken,course_id:course.id,starts_at:selected,minutes:minutes(),account_required:!!window.customerAccount})});
    $('confirmationText').textContent=$('bookingSummary').textContent+' · '+data.instructions;
    $('confirmationCode').textContent='Booking reference: '+data.id;$('payment').replaceChildren();
    if(data.paymentUrl){const link=node('a','Pay for your session','hero-link');link.href=data.paymentUrl;$('payment').append(link);}
    if(data.qr){const img=new Image(160,160);img.src=data.qr;img.alt='Scan to pay';$('payment').append(img);}
    step('successStep');e.target.reset();window.prefillAccount?.();window.dispatchEvent(new Event('booking-saved'));
  }catch(err){$('formError').textContent=err.message;$('formError').hidden=false;try{await refresh();}catch{}}
  finally{resetSecurity();$('submitBooking').disabled=false;}
};
$('bookAnother').onclick=()=>{step('choosePrompt');$('courseList').scrollIntoView();};
$('year').textContent=new Date().getFullYear();
document.querySelectorAll('.course-photo').forEach(img=>{img.addEventListener('error',()=>{img.src='./home-yoga.webp';img.alt='Yoga practice';},{once:true});if(img.complete && !img.naturalWidth){img.src='./home-yoga.webp';img.alt='Yoga practice';}});
const coursePhotos={"Private yoga (1 : 1)":{"src":"https://images.pexels.com/photos/8436411/pexels-photo-8436411.jpeg?auto=compress&cs=tinysrgb&w=640","alt":"Yoga instructor guiding an individual student"},"Small Group Yoga":{"src":"https://images.pexels.com/photos/8436725/pexels-photo-8436725.jpeg?auto=compress&cs=tinysrgb&w=640","alt":"A small group practicing seated yoga together"},"Foundation Class":{"src":"https://images.pexels.com/photos/4056444/pexels-photo-4056444.jpeg?auto=compress&cs=tinysrgb&w=640","alt":"Instructor guiding a student through a yoga pose"},"Group Yoga Session":{"src":"https://images.pexels.com/photos/8436605/pexels-photo-8436605.jpeg?auto=compress&cs=tinysrgb&w=640","alt":"A group practicing yoga poses together"},"Office Workers session":{"src":"https://images.pexels.com/photos/8436731/pexels-photo-8436731.jpeg?auto=compress&cs=tinysrgb&w=640","alt":"A guided seated yoga and relaxation session"}};
function renderCatalog(courses) {
  const cards=courses.map(c=>{
    const card=node('article','','course-card');
    card.append(node('strong',c.title));
    const photo=coursePhotos[c.title];
    if(photo){
      const img=new Image(640,427);img.className='course-photo';img.src=photo.src;img.alt=photo.alt;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>{img.src='./home-yoga.webp';img.alt='Yoga practice';},{once:true});card.append(img);
    }
    card.append(node('p',c.description),
      node('p',c.duration_minutes+' min · '+sessionPrice(c)),
      node('button','Book class →','book-course'));
    card.dataset.id=c.id;card.dataset.minutes=c.duration_minutes;card.dataset.cents=c.price_cents;
    return card;
  });
  $('courseList').replaceChildren(...cards);
  if(!cards.length) $('courseList').textContent='Classes will be available soon.';
}

async function loadCourses() {
  const {courses}=await api('/api/courses',{signal:AbortSignal.timeout(8000)});
  if(!Array.isArray(courses)) throw Error('Invalid catalog');
  catalog=courses;renderCatalog(courses);
  return courses;
}

$('courseList').addEventListener('click',event=>{
  const card=event.target.closest('.course-card');
  if(!card)return;
  for(const other of $('courseList').children)other.classList.toggle('active',other===card);
  choose({id:Number(card.dataset.id)||null,title:card.querySelector('strong').textContent,
    duration_minutes:Number(card.dataset.minutes),price_cents:Number(card.dataset.cents)});
});
if(!pagesPreview)loadCourses().catch(()=>{});
if(!pagesPreview)api('/api/config').then(cfg=>{
  const digits=(cfg.whatsapp || '').replace(/\D/g,'');
  if(/^\d{8,15}$/.test(digits)){
    const a=$('whatsapp');a.href='https://wa.me/'+digits;a.textContent='Questions? WhatsApp +'+digits;a.hidden=false;
  }
}).catch(()=>{}); // Optional contact settings load independently of the classes.


