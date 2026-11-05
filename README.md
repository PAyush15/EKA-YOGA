# Yoga by Krunali · Austin, Texas

One Cloudflare Worker serves the website and booking API. D1 stores reservations. Each reservation holds the instructor's full time across all courses. The 48-hour minimum applies to the session start. Starts are offered daily from 07:00 through 19:00 Austin time. The listed USD rate applies to the listed duration. Other durations require a studio quote.

## First deployment

From this repository with Node.js 22.13+ installed:

```sh
npm ci
npx wrangler login
npm run db:remote
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

Use the existing yoga-bookings database configured in wrangler.jsonc. The schema creates tables and adds the five studio classes on a new database. Skip the old demo seed. Wrangler prints the public URL. Open /admin to review bookings, cancel them or mark a verified payment as paid. Customers receive cancellation updates manually. For a local test run node tests/smoke.mjs. To run locally with Wrangler, configure .dev.vars with both admin credentials, run npm run db:local then npm run dev.

## Studio contact and payments

Set WHATSAPP_NUMBER in wrangler.jsonc to the international phone number. Set PAYMENT_URL to the HTTPS payment link. Add a QR image under public and set PAYMENT_QR_PATH to its site path (for example /payment-qr.png). Redeploy after editing. Until configured the site omits these controls. Only the standard duration shows the published payment link. Confirm the amount directly with customers choosing another duration. A payment link click leaves the booking pending. Verify receipt with the provider before using Mark paid.

## Booking emails

Create a Google Apps Script project using google-apps-script/Code.gs. In Project Settings → Script properties set ADMIN_EMAIL to the studio inbox and NOTIFY_SHARED_SECRET to a random secret of at least 32 characters. Deploy as a Web app running as you, accessible to Anyone. Authorize it and copy the /exec URL. In the project terminal:

```sh
npx wrangler secret put NOTIFY_WEBHOOK_URL
npx wrangler secret put NOTIFY_SHARED_SECRET
```

Enter the /exec URL and the matching secret respectively. Keep credentials outside GitHub. A booking triggers a studio notification and a customer reservation email with payment instructions. Mark paid triggers a separate customer email. Delivery is best effort without retries. Make one test reservation and verify both inboxes before sharing the site.
