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
  let structured = false;
  const respond = (result, legacy) => structured
    ? ContentService.createTextOutput(JSON.stringify({version: 2, ...result})).setMimeType(ContentService.MimeType.JSON)
    : ContentService.createTextOutput(legacy);
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    structured = payload.reportVersion === 2;
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('NOTIFY_SHARED_SECRET');
    const admin = props.getProperty('ADMIN_EMAIL');
    if (!secret || payload.secret !== secret) return respond({error: 'config'}, 'Forbidden');
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(admin || '')) return respond({error: 'config'}, 'Forbidden');
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(payload.email || '')) ||
        !/^[a-f0-9-]{36}$/.test(String(payload.id || '')) ||
        !Number.isFinite(Date.parse(payload.startsAt)) || !Number.isFinite(payload.duration)) {
      return respond({error: 'invalid'}, 'ERROR');
    }
    const eventId = payload.id + (payload.paid ? ':paid' : ':reserved');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return respond({error: 'busy'}, 'ERROR');
    // Keep per-recipient receipts for seven days. Retry only the recipient that failed.
    const now = Date.now();
    const saved = props.getProperties();
    for (const key in saved) {
      if (key.indexOf('sent:') === 0 && Number(String(saved[key]).replace(/^sending:/, '')) < now - 7 * 86400000) props.deleteProperty(key);
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
          '\n\n' + studio
      },
      {
        to: admin,
        subject: (payload.paid ? 'Payment confirmed' : 'New booking · Payment pending') + ' | ' + course,
        body: name.trim() + (payload.paid ? ' is confirmed as paid on your studio schedule.' :
          ' reserved this session. After you verify payment, open Recent reservations and choose Mark paid.') +
          '\n\n' + details + '\nEmail: ' + payload.email + '\nPhone / WhatsApp: ' + (payload.phone || 'Not provided')
      }
    ];
    const results = messages.map((message, i) => {
      // Keep the same keys as the previous deployment so retries recognize its receipts.
      const key = 'sent:' + eventId + ':' + i;
      const receipt = props.getProperty(key);
      if (receipt) return String(receipt).startsWith('sending:') ? 'review' : 'accepted';
      if (MailApp.getRemainingDailyQuota() < 1) return 'quota';

      // If execution stops between sending and saving the receipt, do not blindly resend.
      props.setProperty(key, 'sending:' + now);
      try {
        MailApp.sendEmail(message);
      } catch (error) {
        props.deleteProperty(key);
        console.error('Booking email failed for reference ' + booking + ', recipient ' + i);
        return 'failed';
      }
      props.setProperty(key, String(now));
      return 'accepted';
    });
    return respond({customer: results[0], instructor: results[1]},
      results.every(status => status === 'accepted') ? 'OK' : 'ERROR');
  } catch (err) {
    console.error('Booking notification processing failed');
    return respond({error: 'service'}, 'ERROR');
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

