> **Current email setup:** Booking emails now use Resend. Follow [RESEND-SETUP.md](RESEND-SETUP.md) for required Cloudflare settings, delivery tracking and testing. Apps Script instructions below are retained only for legacy reference.

# Payment details

Edit `src/payment-config.js` in GitHub. Replace the empty quoted values for each method:

- Zelle `recipient`: your registered phone number or email address.
- Venmo `recipient`: your @tag.
- `url`: your full HTTPS payment/profile link, if available. Leave Zelle's blank if you only have a QR and phone number.
- `qrPath`: `/payments/zelle-qr.png` or `/payments/venmo-qr.png`.

Upload the matching QR files into `public/payments/` using **Add file → Upload files**. Filenames are case sensitive. Use PNG, JPG or WebP. These are public customer-facing details; never add a password or bank login.

Commit your edits. Your connected Cloudflare build deploys them. A configured method appears after a successful reservation. Payment instructions and recipient/link also appear in the pending-payment email. QR codes display on the checkout screen. Blank methods are hidden. With no payment details yet, the customer is told the instructor will send payment instructions.

Zelle/Venmo payment is manually verified. In `/admin`, open Recent reservations and click **Mark paid** only after checking receipt in your payment account. This queues payment-confirmed emails for both parties. A click on a payment link does not mark a booking paid.

# Deploy the updated email script (required)

1. Open `google-apps-script/Code.gs` in this repository and copy its full contents.
2. In your existing Google Apps Script project, replace Code.gs with it and save.
3. Keep your existing Script Properties `ADMIN_EMAIL` (where you receive booking messages) and `NOTIFY_SHARED_SECRET`. Do not paste either secret into GitHub.
4. Choose **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. Keep **Execute as: Me** and access **Anyone**. Keep using the same deployment URL ending in `/exec`.
5. In Cloudflare, keep `NOTIFY_WEBHOOK_URL` set to that `/exec` URL and `NOTIFY_SHARED_SECRET` matching Apps Script. These must be runtime settings, not just build settings.

The Worker creates the email queue table automatically and upgrades Small Group Yoga to 60 minutes. No manual database reset is needed. Existing reservations retain their stored start/end times.

# Email behavior and verification

A successful booking transaction saves both the reservation and an email job. The same transaction rejects overlaps across every course, including pending-payment reservations. Public availability returns only busy start/end times; customer details are protected.

Delivery is attempted immediately and failed jobs are retried on a five-minute scheduler with increasing delays, up to eight attempts. `/admin` shows reserved/paid email status (`pending`, `sent`, `failed`, `skipped`) with a **Retry email** button for pending/failed jobs. Refresh the admin page to see changes. `sent` means Apps Script accepted both sends, not proof of inbox delivery. Check spam folders too.

The updated script remembers each successful recipient for seven days, so an ordinary retry after partial failure does not resend to the recipient already served. Mail sending and receipt storage cannot be one atomic operation: a crash immediately after sending can still produce a duplicate. Retrying events older than seven days can resend. Cancelled reservations are skipped; unsent payment-pending notices are skipped if payment is already marked received. Previously sent mail cannot be recalled. Cancellations still require a manual customer message.

After deploying BOTH Worker and Apps Script:

1. Make one clearly labeled test booking using an email you control on the Cloudflare website (not the GitHub Pages demo).
2. Verify the reference, class, date, Austin time and duration in the customer email and `ADMIN_EMAIL` inbox.
3. In a second browser window, check that the same time and overlapping custom starts are unavailable for every class.
4. In `/admin`, confirm email status is `sent`. If not, check Apps Script Executions and the two Cloudflare settings, then use Retry email.
5. Use Mark paid on the TEST reservation to test both payment-confirmed emails; verify repeat clicks do not resend. Cancel the test reservation afterward to release its time. This test does not charge money.

# Scheduling

All rules use Austin's `America/Chicago` timezone, including daylight saving changes. Earliest booking is the date three calendar days after today, beginning at 8 AM (Tuesday at 4 PM allows Friday at 8 AM). The last date is 28 calendar days after today. Allowed START times are 8 AM–6:30 PM weekdays, 8 AM–noon weekends; a session may finish after that latest start. Both frontend and server import the same rules from `public/booking-rules.js`.

# Validation performed

`node --experimental-sqlite tests/smoke.mjs` tests the real Worker against SQLite with mock Google/Turnstile/email services: calendar boundaries, DST, permitted hours, fixed durations, concurrent overlaps, pending-payment blocking, private availability, Google account ownership, invalid requests, notification payloads, retry handling, and Apps Script recipient/deduplication logic. It does not prove delivery by the deployed Gmail account. The external Apps Script deployment and private inboxes require the live check above.

