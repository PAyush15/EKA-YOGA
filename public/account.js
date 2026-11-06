'use strict';
// Google performs both registration and login. The Worker owns authentication.
(() => {
  const el=id=>document.getElementById(id);
  const preview=location.hostname.endsWith('.github.io') || location.protocol==='file:';
  let googleReady, opening=false;
  const message=text=>{el('accountMessage').textContent=text;};
  async function request(path,body) {
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),
      ...(body!==undefined?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok)throw Error(data.error || 'Please try again.');
    return data;
  }
  window.prefillAccount=()=>{
    const user=window.customerAccount,form=el('bookingForm');
    form.elements.email.readOnly=!!user;
    if(user){
      form.elements.email.value=user.email;
      const parts=user.name.trim().split(/\s+/);
      if(!form.elements.first_name.value)form.elements.first_name.value=parts[0] || '';
      if(!form.elements.last_name.value)form.elements.last_name.value=parts.slice(1).join(' ');
    }
    el('accountBookingNote').textContent=user?'This booking will be saved to your account. Confirmation emails go to '+user.email+'.':'Sign in above before booking to save this session to your account, or continue as a guest.';
  };
  function setUser(user){
    window.customerAccount=user;
    el('signedIn').hidden=!user;el('signedOut').hidden=!!user;
    el('accountLink').textContent=user?'My sessions':'Sign up / Log in';
    el('accountIdentity').textContent=user?'Signed in as '+(user.name || user.email)+' · '+user.email:'';
    if(!user)el('mySessions').replaceChildren();
    window.prefillAccount();
  }
  async function sessions(){
    if(!window.customerAccount)return;
    const owner=window.customerAccount.id;
    message('Loading your sessions…');
    try {
      const {bookings}=await request('/api/me/bookings');
      if(window.customerAccount?.id!==owner)return;
      el('mySessions').replaceChildren();
      const format=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
      for(const b of bookings){
        const card=document.createElement('article');card.className='session-card';
        const title=document.createElement('h3');title.textContent=b.title;
        const time=document.createElement('p');time.textContent=format.format(new Date(b.starts_at))+' · Austin time · '+Math.round((Date.parse(b.ends_at)-Date.parse(b.starts_at))/60000)+' minutes';
        const status=document.createElement('p');status.className='session-status';
        status.textContent=b.status==='cancelled'||b.cancelled?'Cancelled':b.paid_at?'Payment received · Confirmed':'Reserved · Payment pending';
        const ref=document.createElement('small');ref.textContent='Booking reference: '+b.id;
        card.append(title,time,status,ref);el('mySessions').append(card);
      }
      message(bookings.length?'Your booked sessions, with the latest payment status.':'No sessions yet. Choose a class to book your first practice.');
    }catch(error){message(error.message);}
  }
  function loadGoogle(){
    if(window.google?.accounts?.id)return Promise.resolve();
    if(!googleReady)googleReady=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
      const timeout=setTimeout(()=>{script.remove();reject(Error('Google sign-in did not load. Check your connection and try again.'));},15000);
      script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);script.remove();reject(Error('Google sign-in could not load. Please try again.'));};document.head.append(script);
    }).catch(error=>{googleReady=null;throw error;});
    return googleReady;
  }
  async function signIn(){
    if(opening)return;opening=true;el('retrySignIn').hidden=true;el('googleSignIn').replaceChildren();
    if(preview){message('Accounts are available on the live booking website once Google sign-in is connected. This GitHub Pages version is a booking demo.');opening=false;return;}
    message('Loading secure Google sign-in…');
    try {
      const {nonce,clientId}=await request('/api/auth/nonce',{});
      await loadGoogle();
      google.accounts.id.initialize({client_id:clientId,nonce,auto_select:false,callback:async response=>{
        message('Signing you in…');
        try {const {user}=await request('/api/auth/google',{credential:response.credential});setUser(user);await sessions();}
        catch(error){message(error.message);el('retrySignIn').hidden=false;}
      }});
      google.accounts.id.renderButton(el('googleSignIn'),{theme:'outline',size:'large',text:'continue_with',shape:'pill'});
      message('Sign in to save and view your yoga bookings.');
    }catch(error){message(error.message);el('retrySignIn').hidden=false;}
    finally{opening=false;}
  }
  el('accountLink').onclick=async event=>{
    event.preventDefault();el('account').hidden=false;el('account').scrollIntoView({block:'start'});el('account').focus({preventScroll:true});
    if(window.customerAccount)await sessions();else await signIn();
  };
  el('closeAccount').onclick=()=>{el('account').hidden=true;el('accountLink').focus();};
  el('retrySignIn').onclick=signIn;el('refreshSessions').onclick=sessions;
  el('logout').onclick=async()=>{
    el('logout').disabled=true;
    try {await request('/api/auth/logout',{});setUser(null);el('bookingForm').reset();window.google?.accounts.id.disableAutoSelect();await signIn();}
    catch(error){message(error.message);}finally{el('logout').disabled=false;}
  };
  window.addEventListener('booking-saved',()=>{if(!el('account').hidden)sessions();});
  setUser(null);
  if(!preview)request('/api/auth/me').then(data=>setUser(data.user)).catch(()=>{});
})();
