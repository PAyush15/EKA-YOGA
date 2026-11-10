/**
 * Optional email notification endpoint for Cloudflare Worker.
 * Set script properties:
 *   NOTIFY_SHARED_SECRET = same as Wrangler secret
 *   ADMIN_EMAIL = your existing Gmail address
 * Deploy as Web App: Execute as Me; Access Anyone.
 * The secret is checked on EVERY request.
 */
function doPost(e) {
  let lock;
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('NOTIFY_SHARED_SECRET');
    const admin = props.getProperty('ADMIN_EMAIL');
    if (!secret || !admin || payload.secret !== secret) {
      return ContentService.createTextOutput('Forbidden');
    }
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(payload.email || '')) ||
        !/^[a-f0-9-]{36}$/.test(String(payload.id || '')) ||
        !Number.isFinite(Date.parse(payload.startsAt)) || !Number.isFinite(payload.duration)) {
      return ContentService.createTextOutput('ERROR');
    }
    const eventId = payload.id + (payload.paid ? ':paid' : ':reserved');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return ContentService.createTextOutput('ERROR');
    // Keep per-recipient receipts for seven days. Retry only the recipient that failed.
    const now = Date.now();
    const saved = props.getProperties();
    for (const key in saved) {
      if (key.indexOf('sent:') === 0 && Number(saved[key]) < now - 7 * 86400000) props.deleteProperty(key);
    }
    const name = String(payload.firstName || '') + ' ' + String(payload.lastName || '');
    const course = String(payload.course || 'Yoga class');
    const zoned = Utilities.formatDate(new Date(payload.startsAt), String(payload.studioTimezone || 'America/Chicago'), 'EEE, dd MMM yyyy, hh:mm a z');
    const studio = String(payload.studioName || 'Yoga Studio');
    const booking = String(payload.id || '');
    const details = course + '\n' + zoned + ' · ' + payload.duration + ' minutes\nBooking reference: ' + booking;
    const customerBody = payload.paid
      ? 'Your payment has been received and your at-home yoga session is confirmed. I’ll come to you for the class.'
      : "You're almost there! We've held a time for your at-home yoga session. " + payload.instructions +
        (payload.paymentUrl ? '\n\nComplete your payment: ' + payload.paymentUrl : '');
    const messages = [
      {
        to: String(payload.email), replyTo: admin,
        subject: (payload.paid ? 'Your yoga session is confirmed' : 'Your yoga session is reserved — payment pending') + ' | ' + studio,
        body: 'Hi ' + payload.firstName + ',\n\n' + customerBody + '\n\n' + details +
          '\n\nPlease reply with the address for your session if you haven’t already shared it.\n' + studio
      },
      {
        to: admin,
        subject: (payload.paid ? 'Payment confirmed' : 'New booking · Payment pending') + ' | ' + course,
        body: name.trim() + (payload.paid ? ' is confirmed as paid on your studio schedule.' :
          ' reserved this session. After you verify payment, open Recent reservations and choose Mark paid.') +
          '\n\n' + details + '\nEmail: ' + payload.email + '\nPhone / WhatsApp: ' + (payload.phone || 'Not provided')
      }
    ];
    // Attempt both deliveries even when one recipient fails.
    let failed = false;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const key = 'sent:' + eventId + ':' + i;
      if (props.getProperty(key)) continue;
      try { MailApp.sendEmail(message); props.setProperty(key, String(now)); }
      catch (error) { failed = true; console.error('Booking email failed for reference ' + booking); }
    }
    if (failed) return ContentService.createTextOutput('ERROR');
    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error('Booking notification processing failed');
    return ContentService.createTextOutput('ERROR');
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}


