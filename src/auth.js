// Google identity verification and opaque, server-side customer sessions.
const COOKIE = '__Host-yoga_session';
const NONCE_COOKIE = '__Host-yoga_nonce';
const TTL = 7 * 86400;
const encoder = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: {'content-type':'application/json', 'cache-control':'no-store', ...headers}
});
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
function getCookie(request, name) {
  return (request.headers.get('cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1) || '';
}
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))), b=>b.toString(16).padStart(2,'0')).join('');
}
function decode(part) {
  return Uint8Array.from(atob(part.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
}
let keys, keysUntil = 0;
export async function verifyGoogle(token, clientId, nonce) {
  if(typeof token !== 'string' || token.length > 7000) throw Error('Invalid Google credential.');
  const parts=token.split('.');
  if(parts.length!==3) throw Error('Invalid Google credential.');
  const header=JSON.parse(new TextDecoder().decode(decode(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decode(parts[1])));
  if(header.alg!=='RS256' || typeof header.kid!=='string') throw Error('Invalid signing key.');
  if(!keys || Date.now() >= keysUntil) {
    const response=await fetch('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw Error('Google verification unavailable.');
    keys=(await response.json()).keys;
    keysUntil=Date.now()+300000;
  }
  const jwk=keys.find(k=>k.kid===header.kid && k.kty==='RSA' && k.use==='sig');
  if(!jwk) throw Error('Unknown signing key. Please try again shortly.');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),encoder.encode(parts[0]+'.'+parts[1]))) throw Error('Invalid signature.');
  const now=Date.now()/1000;
  if(claims.aud!==clientId || !['accounts.google.com','https://accounts.google.com'].includes(claims.iss) ||
     !Number.isFinite(claims.exp) || claims.exp<=now || !Number.isFinite(claims.iat) || claims.iat>now+60 ||
     typeof claims.sub!=='string' || !claims.sub || claims.sub.length>255 || claims.nonce!==nonce ||
     claims.email_verified!==true || typeof claims.email!=='string' || claims.email.length>200 ||
     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) throw Error('Invalid Google account credential.');
  return claims;
}
export async function currentUser(request, env) {
  const token=getCookie(request,COOKIE);
  if(!/^[a-f0-9]{64}$/.test(token)) return null;
  return env.DB.prepare(`SELECT u.id,u.email,u.name FROM customer_sessions s
    JOIN customers u ON u.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>?`)
    .bind(await hash(token),Math.floor(Date.now()/1000)).first();
}
export async function authRoute(request, env, parseJSON) {
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/api/auth/') && path!=='/api/me/bookings') return null;
  // All mutations require an explicit same-origin JSON request, including login.
  if(request.method!=='GET' && (request.headers.get('origin')!==new URL(request.url).origin ||
      !request.headers.get('content-type')?.startsWith('application/json'))) return json({error:'Invalid request origin.'},403);
  if(path==='/api/auth/nonce' && request.method==='POST') {
    if(!env.GOOGLE_CLIENT_ID) return json({error:'Google sign-in has not been configured yet.'},503);
    const nonce=random(), now=Math.floor(Date.now()/1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_challenges WHERE expires_at<=?').bind(now),
      env.DB.prepare('DELETE FROM customer_sessions WHERE expires_at<=?').bind(now),
      env.DB.prepare('INSERT INTO login_challenges(nonce_hash,expires_at) VALUES(?,?)').bind(await hash(nonce),now+600)
    ]);
    return json({nonce,clientId:env.GOOGLE_CLIENT_ID},200,{'set-cookie':cookie(NONCE_COOKIE,nonce,600)});
  }
  if(path==='/api/auth/google' && request.method==='POST') {
    if(!env.GOOGLE_CLIENT_ID) return json({error:'Google sign-in has not been configured yet.'},503);
    const d=await parseJSON(request), nonce=getCookie(request,NONCE_COOKIE);
    if(!/^[a-f0-9]{64}$/.test(nonce)) return json({error:'Please reopen sign-in and try again.'},401);
    let claims;
    try {claims=await verifyGoogle(d.credential,env.GOOGLE_CLIENT_ID,nonce);}
    catch {return json({error:'Google sign-in could not be verified. Please try again.'},401);}
    const now=Math.floor(Date.now()/1000);
    const challenge=await env.DB.prepare('DELETE FROM login_challenges WHERE nonce_hash=? AND expires_at>? RETURNING nonce_hash')
      .bind(await hash(nonce),now).first();
    if(!challenge) return json({error:'Sign-in expired. Please reopen sign-in.'},401);
    const name=typeof claims.name==='string'?claims.name.slice(0,140):'';
    const email=claims.email.toLowerCase(), token=random();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO customers(id,email,name) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name`).bind(claims.sub,email,name),
      env.DB.prepare('INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(?,?,?)').bind(await hash(token),claims.sub,now+TTL)
    ]);
    const headers=new Headers({'content-type':'application/json','cache-control':'no-store'});
    headers.append('set-cookie',cookie(COOKIE,token,TTL));headers.append('set-cookie',cookie(NONCE_COOKIE,'',0));
    return new Response(JSON.stringify({user:{id:claims.sub,email,name}}),{headers});
  }
  if(path==='/api/auth/me' && request.method==='GET') return json({user:await currentUser(request,env)});
  if(path==='/api/auth/logout' && request.method==='POST') {
    const token=getCookie(request,COOKIE);
    if(token) await env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash=?').bind(await hash(token)).run();
    return json({ok:true},200,{'set-cookie':cookie(COOKIE,'',0)});
  }
  if(path==='/api/me/bookings' && request.method==='GET') {
    const user=await currentUser(request,env);
    if(!user) return json({error:'Please sign in to view your sessions.'},401);
    const {results}=await env.DB.prepare(`SELECT b.id,b.status,s.cancelled,s.starts_at,s.ends_at,c.title,
      p.paid_at FROM customer_bookings cb JOIN bookings b ON b.id=cb.booking_id
      JOIN sessions s ON s.id=b.session_id JOIN courses c ON c.id=s.course_id
      LEFT JOIN payments p ON p.booking_id=b.id WHERE cb.customer_id=? ORDER BY s.starts_at DESC LIMIT 300`)
      .bind(user.id).all();
    return json({bookings:results});
  }
  return json({error:'Not found.'},404);
}
