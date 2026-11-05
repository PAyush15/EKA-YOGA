/**
 * Optional email notification endpoint for Cloudflare Worker.
 * Set script properties:
 *   NOTIFY_SHARED_SECRET = same as Wrangler secret
 *   ADMIN_EMAIL = your existing Gmail address
 * Deploy as Web App: Execute as Me; Access Anyone.
 * The secret is checked on EVERY request.
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('NOTIFY_SHARED_SECRET');
    const admin = props.getProperty('ADMIN_EMAIL');
    if (!secret || !admin || payload.secret !== secret) {
      return ContentService.createTextOutput('Forbidden');
    }
    const name = String(payload.firstName || '') + ' ' + String(payload.lastName || '');
    const course = String(payload.course || 'Yoga class');
    const zoned = Utilities.formatDate(new Date(payload.startsAt), String(payload.studioTimezone || 'America/Chicago'), 'EEE, dd MMM yyyy, HH:mm z');
    const studio = String(payload.studioName || 'Yoga Studio');
    const booking = String(payload.id || '');
    if (payload.paid) {
      MailApp.sendEmail(String(payload.email), 'Payment received — ' + studio,
        'Hello ' + payload.firstName + ', your payment has been recorded for ' + course + ' on ' + zoned + '. Booking reference: ' + booking);
      return ContentService.createTextOutput('OK');
    }
    MailApp.sendEmail({
      to: admin,
      subject: 'New booking: ' + course,
      body: `A new yoga class was reserved.\n\nClass: ${course}\nWhen: ${zoned}\nCustomer: ${name}\nEmail: ${payload.email}\nPhone: ${payload.phone || 'Not provided'}\nDuration: ${payload.duration} minutes. Payment pending.\nBooking reference: ${booking}\n\nReview the admin dashboard to manage the booking.`
    });
    MailApp.sendEmail({
      to: String(payload.email),
      subject: 'Reserved, payment pending — ' + studio,
      body: `Hello ${payload.firstName},\n\nYour session is reserved. Payment is pending. ${payload.instructions} ${payload.paymentUrl || ''}\n\nClass: ${course}\nWhen: ${zoned} (${payload.duration} minutes)\nReference: ${booking}\n\nWe look forward to seeing you.\n\n${studio}\n\nTo cancel, please contact the studio directly.`
    });
    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error(err);
    return ContentService.createTextOutput('ERROR');
  }
}

