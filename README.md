# Yoga Booking — free Acuity-style starter

A responsive group yoga booking website with **real D1 reservations**, a simple protected admin dashboard, optional Gmail email notifications, and no mandatory customer login.

## Included

- Public course listing, monthly calendar and available sessions
- Guest booking form (name, email, optional phone)
- Atomic SQLite conditional booking to enforce class capacity
- Prevent repeat active bookings from the same email for the same session
- Admin dashboard to create/hide courses, publish/cancel dates, view/cancel bookings
- Optional two-way email notifications via Gmail and Apps Script
- Default sample content, responsive design, and local-only preview mode

**Not included yet:** payments, customer login, automatic reminders, waitlists, recurring-session editor, automated cancellation emails, custom domain, full GDPR compliance documentation, spam challenges, production monitoring/backup strategy. This is an MVP, not a finished payment processor.

## Requirements / free services

1. Free Cloudflare account (Workers + D1)
2. Free GitHub account (code storage; optional, but recommended)
3. Node.js installed locally to use Wrangler
4. Optional Google account for Apps Script email notifications

Cloudflare runs BOTH the website and booking API on a single Worker; GitHub stores the code. No GitHub Pages site is needed.

## Run in preview mode — no account needed

Open `public/index.html` in your browser. You can explore the design and calendar; preview bookings are disabled to avoid misrepresenting demo reservations as real.

## Run locally with a REAL database

In a terminal at the project root:

```bash
npm install
cp .dev.vars.example .dev.vars
# Update ADMIN_PASSWORD with a long random password.
npm run db:local
npm run seed:local
npm run dev
```

Open http://localhost:8787 for the public website or http://localhost:8787/admin for the protected admin dashboard.

The included seed inserts **demo classes and session times**. Do not use the sample prices/times without checking them. The sample times are UTC and might not match your actual local yoga class times, especially after DST changes.

## Publish for free

1. Create a free Cloudflare account.
2. Install dependencies and log in:

```bash
npm install
npx wrangler login
```

3. Create the production database:

```bash
npx wrangler d1 create yoga-bookings
```

4. Copy the returned `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. Ensure the binding remains named **DB**.
5. Initialize tables:

```bash
npm run db:remote
```

6. Optional for demonstration only (sample courses and dates):

```bash
npm run seed:remote
```

7. Set **both** admin credentials as secrets:

```bash
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

Use a long randomly generated password. Never put the password in GitHub, source files or public variables.

8. Edit `wrangler.jsonc` `STUDIO_NAME` and `STUDIO_TIMEZONE` (valid IANA time zone such as `Europe/Berlin`, `America/Chicago`, or `Asia/Kolkata`). Then deploy:

```bash
npm run deploy
```

Cloudflare prints a public URL such as `https://yoga-booking-starter.<your-account>.workers.dev`.

9. Open `/admin` on your URL, sign in with the Basic Auth username/password, and enter actual courses and class times. Anyone with the public URL can make guest bookings; only the administrator can view customer data.

**Important:** The admin calendar uses your *computer's local timezone* when saving sessions. Set your computer to the studio time zone or convert times accordingly before publishing. The public booking calendar formats times with `STUDIO_TIMEZONE`.

### Optional: automatic GitHub deployments

Create a private GitHub repository and upload this project, excluding `.dev.vars` and `node_modules` (the `.gitignore` already covers both). Deploy changes with Wrangler. Cloudflare's GitHub integration can also be configured for automatic deployments once the account is connected, but manual deployment is simplest for the first launch.

## Optional: Gmail notifications

**You do not need email to save bookings.** Booking works independently; email is a best-effort notification add-on and can fail independently of a successful reservation.

1. Visit https://script.google.com and create a new project.
2. Paste the contents of `google-apps-script/Code.gs`.
3. Open **Project Settings → Script properties**, create:
   - `ADMIN_EMAIL` = your notification Gmail address
   - `NOTIFY_SHARED_SECRET` = a random long string (at least 32 characters)
4. Deploy → New deployment → Web app. Set **Execute as: Me** and **Who has access: Anyone**. Authorize your own Google account. Copy the `/exec` URL.
5. In the project terminal, run:

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
npx wrangler secret put NOTIFY_SHARED_SECRET
```

Paste the `/exec` URL as the first secret, and the *same* random secret as the second. Deploy the Worker again if needed.

The Worker sends booking details only to your Apps Script endpoint and never exposes the secret to the browser. Apps Script sends one email to the admin and one to the customer. Personal Gmail has recipient quotas (currently 100 recipients/day through Apps Script), which can restrict high-volume bookings.

**Production caveat:** Apps Script `doPost` returns HTTP 200 even when the response body says `ERROR` or `Forbidden`. The starter logs HTTP failures but does not confirm actual delivery, retry failed notifications, or queue emails. Verify with a test booking before opening bookings to customers. For reliable production email, use an authenticated email service and a retry queue.

## Privacy, security and payments

- This project stores names, emails and optionally phone numbers. Add a real privacy policy, retention rules, and a secure data export/deletion process before launching (particularly under the GDPR).
- Do not use it to collect health or medical information without an appropriate legal and technical review.
- Use Cloudflare and Google privacy and data-processing settings appropriate for your country.
- Add Turnstile or equivalent anti-abuse measures and operational backups before public promotion.
- You can display class prices, but no payments are collected. Collecting card payments needs a payment provider, which normally charges transaction fees.
- `/admin` and `/api/admin/*` use HTTP Basic Authentication over HTTPS. This is an MVP protection for one studio administrator, not a full staff-account system.
- Changing or cancelling bookings does not automatically notify participants; do that manually until cancellation notifications are implemented.

## Customize

- `public/index.html`: webpage structure and wording
- `public/styles.css`: colors, typography, layout
- `public/app.js`: booking calendar and guest form
- `public/admin.html`, `public/admin.js`: admin dashboard
- `src/worker.js`: server-side API and database logic
- `schema.sql`: database schema
- `wrangler.jsonc`: studio name/timezone and D1 binding (do **not** add secrets here)

## Database workflow note

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, but it is intended for **new deployments**. Future schema changes should use versioned migrations, not destructive re-initialization.
