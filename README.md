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

Enter the /exec URL and the matching secret respectively. Keep credentials outside GitHub. A booking triggers a studio notification and a customer reservation email with payment instructions. After verifying the transfer, open /admin → Recent reservations → Mark paid. This updates Upcoming sessions to Paid · Confirmed and triggers separate confirmation emails to both recipients. If the Apps Script web app already exists, update its deployment to a new version after replacing Code.gs. GitHub Pages is a browser-only demo and does not send mail. Delivery is best effort without retries. Make one test reservation and verify both inboxes before sharing the site.


## Customer signup, Google login and My sessions

Google is the signup and login method: the first successful Google sign-in creates an account. No separate email/password registration is included. Guests can still book. Signed-in bookings use the account email and appear under **My sessions**, with reserved/payment pending, paid/confirmed, or cancelled status. Refresh the list after an administrator changes a booking. Existing guest reservations are not automatically claimed by matching email addresses.

### Enable on the live Cloudflare website

1. Deploy the Worker if you have not already done so, using the first-deployment steps above. Copy its HTTPS website origin (for example `https://yoga-by-krunali.YOUR-SUBDOMAIN.workers.dev`). Use the Cloudflare website for real bookings and accounts; `github.io` remains a static demo.
2. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview), create/select a project, and configure Branding and Audience for Yoga by Krunali. Use your support email and the real website/privacy-policy URLs requested by Google. For public customers use an External audience; while testing, add your own Google account as a test user. Complete any production publishing/verification requirements shown by Google before opening sign-in to everyone.
3. In **Clients → Create client**, choose **Web application**. Add your exact Cloudflare website origin under **Authorized JavaScript origins**: scheme and hostname only, with no `/public/` or other path. Add your custom-domain origin too if you use one. This implementation uses Google's JavaScript callback, so it does not require an authorized redirect URI. Use only basic identity scopes (`openid`, email, profile).
4. Copy the client ID ending in `.apps.googleusercontent.com` into `vars.GOOGLE_CLIENT_ID` in `wrangler.jsonc`. This ID is public configuration; no Google client secret is needed or should be committed.
5. Pull the latest repository code and run:

   ```sh
   npm ci
   npm run db:remote
   npm run deploy
   ```

   The schema adds four account tables without deleting existing bookings. Run the database update before deploying this version. Preserve existing Wrangler secrets, including admin and notification configuration.
6. Open the live Cloudflare URL, click **Sign up / Log in**, and continue with Google. Book while signed in, then open **My sessions**. Verify the reservation appears as payment pending. Mark it paid in `/admin`, refresh My sessions and check it shows confirmed. Log out and verify sessions are no longer accessible. Use two different accounts to check each sees only its own bookings.

Official Google setup reference: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

### Security and verification

The Worker verifies Google's RSA signature, issuer, audience, expiry, verified email and a one-use nonce. Accounts use Google's stable subject ID. Browser sessions last seven days and use random opaque tokens in Secure, HttpOnly, SameSite cookies; only token hashes are stored in D1. No Google tokens are saved in browser storage. Every customer session query is scoped to the authenticated account; typing another email cannot grant access. Login/logout require same-origin JSON requests. Private API responses are not cached.

Run `node --experimental-sqlite tests/smoke.mjs` for booking and auth checks. Auth tests sign real RSA test credentials and mock only Google's public-key endpoint; an actual Google account login still needs the client configuration and live HTTPS deployment above.
