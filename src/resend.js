import { paymentMethods, paymentInstructions } from './payment-config.js';

export function emailPayload(env,b,kind,recipient) {
  const studio=env.STUDIO_NAME||'Yoga by Krunali';
  const paid=kind==='paid';
  const when=new Intl.DateTimeFormat('en-US',{dateStyle:'full',timeStyle:'short',timeZone:env.STUDIO_TIMEZONE||'America/Chicago'}).format(new Date(b.starts_at));
  const address=[b.address_line1,b.address_line2,[b.address_city,b.address_state,b.address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const details=`${b.title}\n${when} (Austin time)\n${(Date.parse(b.ends_at)-Date.parse(b.starts_at))/60000} minutes\nBooking reference: ${b.id}\nSession address: ${address||'See admin booking record'}`;
  const customer=recipient==='customer';
  const introduction=paid?'Your payment has been received and your at-home yoga session is confirmed.':"You're almost there! Your session is reserved, with payment pending.";
  return {from:env.EMAIL_FROM,to:[customer?b.email:env.ADMIN_EMAIL],reply_to:env.EMAIL_REPLY_TO||env.ADMIN_EMAIL,
    subject:(customer?(paid?'Your yoga session is confirmed':'Your yoga session is reserved - payment pending'):(paid?'Payment confirmed':'New booking - payment pending'))+' | '+studio,
    text:customer?`Hi ${b.first_name},\n\n${introduction}\n\n${details}${paid?'':'\n\n'+paymentInstructions(b.price_cents,paymentMethods(env))}\n\nReply to this email if you need help.\n${studio}`:
      `${b.first_name} ${b.last_name}${paid?' is confirmed as paid.':' reserved a session. Verify payment before choosing Mark paid in the admin page.'}\n\n${details}\nEmail: ${b.email}\nPhone: ${b.phone}\n\nhttps://yogabykrunali.com/admin`};
}

const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export async function verifyWebhook(body,headers,secret,now=Date.now()) {
  const id=headers.get('svix-id'),timestamp=headers.get('svix-timestamp');
  if(!secret?.startsWith('whsec_')||!id||!/^\d+$/.test(timestamp||'')||Math.abs(now/1000-Number(timestamp))>300)throw Error('Invalid webhook');
  const key=await crypto.subtle.importKey('raw',bytes(secret.slice(6)),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const signed=new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for(const entry of (headers.get('svix-signature')||'').split(' ')) {
    const [version,signature]=entry.split(',');
    if(version!=='v1'||!signature)continue;
    try {if(await crypto.subtle.verify('HMAC',key,bytes(signature),signed))return JSON.parse(body);}catch{}
  }
  throw Error('Invalid webhook');
}
export const eventTypes=['email.sent','email.delivered','email.delivery_delayed','email.bounced','email.failed','email.complained','email.suppressed'];
export async function resendWebhook(request,env) {
  if(!env.RESEND_WEBHOOK_SECRET)return new Response('Webhook not configured',{status:503});
  // Bound the raw body before signature verification. Never log payloads or secrets.
  const reader=request.body?.getReader();if(!reader)return new Response('Missing body',{status:400});
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}
  const raw=new Uint8Array(size);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
  let event;try{event=await verifyWebhook(new TextDecoder().decode(raw),request.headers,env.RESEND_WEBHOOK_SECRET);}catch{return new Response('Invalid signature',{status:400});}
  if(!eventTypes.includes(event?.type))return new Response('Ignored');
  if(typeof event.data?.email_id!=='string'||!Number.isFinite(Date.parse(event.created_at)))return new Response('Invalid event',{status:400});
  // Persist before acknowledging, even if the callback beats the send API response.
  await env.DB.prepare(`INSERT OR IGNORE INTO email_events(id,provider_id,type,occurred_at) VALUES(?,?,?,?)`)
    .bind(request.headers.get('svix-id'),event.data.email_id,event.type,new Date(event.created_at).toISOString()).run();
  return new Response('OK');
}
