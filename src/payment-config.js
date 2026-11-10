// Edit only the quoted values below. These are CUSTOMER-VISIBLE payment details.
// Upload your QR images to public/payments/, then set qrPath to '/payments/filename.png'.
// Leave a method blank until ready. Never put account passwords or bank credentials here.
export const PAYMENT_METHODS = [
  { name: 'Zelle', recipient: '737-999-3999', url: '', qrPath: '/payments/zelle-qr.jpeg' }, // recipient: your Zelle phone number or email
  { name: 'Venmo', recipient: '@kru6196', url: '', qrPath: '/payments/venmo-qr.jpeg' } // recipient: @your-tag; url: your full https://venmo.com/... link
];
const safeURL = value => {try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export function paymentMethods(env={}) {
  const methods=PAYMENT_METHODS.map(m=>({name:m.name,recipient:m.recipient.trim(),url:safeURL(m.url),qr:m.qrPath.startsWith('/payments/')&&!m.qrPath.includes('..')?m.qrPath:''})).filter(m=>m.recipient||m.url||m.qr);
  if(!methods.length && safeURL(env.PAYMENT_URL))methods.push({name:'Payment link',recipient:'',url:safeURL(env.PAYMENT_URL),qr:''});
  return methods;
}
export function paymentInstructions(amount,methods) {
  const lines=['Your session is reserved, with payment pending. Total: $'+(amount/100).toFixed(2)+'.'];
  for(const m of methods)lines.push(m.name+': '+[m.recipient,m.url].filter(Boolean).join(' · '));
  lines.push(methods.length?'Include your booking reference with payment. Your instructor will confirm receipt.':'Your instructor will send you payment instructions.');
  return lines.join('\n');
}
