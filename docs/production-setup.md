# Production setup

Everything to check before the first production deploy from `main`. Production is the Firebase project `niemansdetailing`, served at `https://niemansdetailing.com`. Staging setup lives in [firebase-staging-setup.md](firebase-staging-setup.md).

There are two stages:

1. **First production run** (sections 1–6). The current site, quote intake, Telegram alerts, admin, blog and the new UI. Appointments, deposits and customer email stay off.
2. **Turning on appointments** (section 7). Live Stripe deposits, Calendar sync, customer email and the first-party booking page. The code is ready; it needs the keys in section 7, then one GitHub variable.

## What the workflows do

| Workflow | Runs when | What it does |
| --- | --- | --- |
| `Deploy production` (`deploy.yaml`) | Every push to `main`, or manually from Actions on `main` | Checks secrets, builds and unit-tests Functions, runs the appointment API against emulators, builds images and the blog, runs Lighthouse (report only), deploys Functions + Firestore rules/indexes, deploys Hosting, then smoke-tests the live site. Any failure before the deploy steps stops the release. |
| `Publish blog to production` (`build-blog-manual.yaml`) | Manually from Actions on `main` | Rebuilds the blog from production Firestore and redeploys Hosting only. Use after publishing posts in `/admin/blog`. |
| `Deploy Firebase staging` (`deploy-staging.yaml`) | Every push to `staging` | Unchanged except for the image cache. |

Both production workflows share one concurrency group, so they never deploy at the same time. Optimized images are cached between runs and only changed images are rebuilt.

## 1. GitHub settings

Open **Settings → Environments → New environment** and create **`production`** (the first run creates it automatically if you skip this, but without the protections below).

- **Deployment branches:** choose *Selected branches* and add `main`.
- **Required reviewers (optional):** add yourself if you want to press *Approve* in Actions before each production deploy. Without it, every merge to `main` goes live.

Add these to the `production` environment. Repository-level secrets with the same names also work, so if they already exist under **Settings → Secrets and variables → Actions** you can leave them there.

| Kind | Name | Required | Value and where to get it |
| --- | --- | --- | --- |
| Secret | `FIREBASE_SERVICE_ACCOUNT_NIEMANSDETAILING` | Yes | JSON key of the production deploy service account (section 2). The workflow refuses a key from any other project. |
| Secret | `TELEGRAM_BOT_TOKEN` | Yes | From **@BotFather** in Telegram: `/mybots` → your bot → *API Token*. |
| Secret | `TELEGRAM_CHAT_ID` | Yes | The chat that receives lead alerts. Send the bot a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`. |
| Variable | `HOSTING_ORIGIN` | No | Defaults to `https://niemansdetailing.com`. It must be the exact origin customers use (no `www`, no trailing slash) or quote submissions are blocked by CORS. A `HOSTING_ORIGIN` secret from the old workflow is still read. |
| Variable | `ENABLE_APPOINTMENTS` | No | Leave unset (off) for the first run. See section 7. |

These three secrets were already used by the old workflow, so they probably exist. Check the service account key is still valid, because the old workflow only deployed one function.

## 2. Google Cloud: deploy service account

Project: [niemansdetailing in Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts?project=niemansdetailing).

The first run deploys more than before: the `notifyLeadAddonUpdate` Firestore trigger (Telegram alert when a customer adds services to a quote) was in the code but was never deployed by CI. Firestore triggers need Eventarc, so the existing key may be missing roles. Open the service account whose email matches `client_email` in the current key (likely `github-action-…@niemansdetailing.iam.gserviceaccount.com`) and make sure it has:

| Role | Role ID | Why |
| --- | --- | --- |
| Firebase Viewer | `roles/firebase.viewer` | Read the project |
| Firebase Hosting Admin | `roles/firebasehosting.admin` | Release Hosting |
| Firebase Rules Admin | `roles/firebaserules.admin` | Firestore rules |
| Cloud Datastore Index Admin | `roles/datastore.indexAdmin` | Firestore indexes |
| Cloud Functions Admin | `roles/cloudfunctions.admin` | Deploy functions |
| Eventarc Admin | `roles/eventarc.admin` | Firestore trigger |
| Service Usage Consumer | `roles/serviceusage.serviceUsageConsumer` | Use enabled APIs |
| Service Account User | `roles/iam.serviceAccountUser` | On the runtime/build account, usually `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` |
| Cloud Scheduler Admin | `roles/cloudscheduler.admin` | Only once appointments are on (scheduled job) |

The project number is under Firebase **Project settings → General**.

If you need a new key: service account → **Keys → Add key → Create new key → JSON**, paste the whole file into `FIREBASE_SERVICE_ACCOUNT_NIEMANSDETAILING`, then delete the old key.

**APIs** (APIs & Services → Library): Cloud Functions, Cloud Run Admin, Cloud Build, Artifact Registry, Eventarc, Pub/Sub. The deploy account cannot turn on a disabled API, so if a run fails naming one, enable it and re-run.

**Functions runtime account** (the compute account above): Cloud Datastore User (`roles/datastore.user`) and Eventarc Event Receiver (`roles/eventarc.eventReceiver`).

## 3. Firebase console (production)

- **Billing:** Blaze plan (already required for Functions).
- **Authentication → Settings → Authorized domains:** `niemansdetailing.com`, `www.niemansdetailing.com`, `niemansdetailing.firebaseapp.com`, `niemansdetailing.web.app`.
- **Authentication → Sign-in method:** Google enabled (admin sign-in).
- **Firestore → `adminUsers`:** a document whose ID is your production UID, so `/admin` lets you in. It should already exist.
- **Hosting → Custom domains:** `niemansdetailing.com` connected, `www.niemansdetailing.com` set to **redirect** to it. Checked 2026-11-20: `www` already returns a 301 to the apex domain. Keep it that way, because the API only accepts requests from `HOSTING_ORIGIN`.

## 4. Google Maps browser key

The key ending `…Zfu5I` (`public/scripts/maps-config.mjs` and the homepage map) is shipped to browsers, so its restrictions are its protection. In [Credentials](https://console.cloud.google.com/apis/credentials?project=niemansdetailing), open that key:

**Application restrictions → Websites**, one per line:

```
https://niemansdetailing.com/*
https://www.niemansdetailing.com/*
https://niemansdetailing.web.app/*
https://niemansdetailing.firebaseapp.com/*
https://niemansdetailing-staging.web.app/*
https://niemansdetailing-staging.firebaseapp.com/*
http://localhost:*/*
http://127.0.0.1:*/*
```

The `www` entry matters only if `www` ever serves pages instead of redirecting, but it costs nothing. Remove the two localhost lines if you never test locally.

**API restrictions → Restrict key:** Maps JavaScript API and Places API (New). Both must also be enabled under APIs & Services.

**Budget:** under Billing → Budgets & alerts, add a monthly budget alert so a leaked or abused key shows up quickly. Optionally set per-day quotas on Places API (New) under its Quotas page.

The Firebase web key (`AIzaSyBgUnt…` in `firebase-config.mjs`) is a different key. If you restrict it, allow the same production domains, **including `https://niemansdetailing.firebaseapp.com/*`**, and keep Identity Toolkit, Token Service, Firestore and Firebase Installations APIs allowed. Google sign-in runs its popup on the `firebaseapp.com` domain, so without that referrer it fails with "The requested action is invalid".

## 5. First production run

1. Open a pull request from `staging` to `main` and merge it once staging looks right.
2. In **Actions → Deploy production**, watch the run (approve it if you added a reviewer). It takes roughly 10–15 minutes; the first run is slower because the image cache is empty.
3. The run ends with a smoke test of `/`, `/quote`, `/schedule`, `/blog`, `/admin`, the deployed Firebase config, and an intentionally invalid quote submission.
4. Then check by hand: submit a real-looking quote at `/quote`, confirm the Telegram alert, and sign in at `/admin`.

**If something breaks:** in Firebase console **Hosting → Release history**, choose *Rollback* on the previous release for the site. For Functions, revert the commit on `main`; the workflow redeploys the previous code.

**Common first-run failures:**

- *"Add these secrets to the production environment"*: a secret in section 1 is missing or misspelled.
- *"The deployment credential must belong to the production Firebase project"*: the key is for staging or another project.
- *Permission denied / API not enabled* during *Deploy Functions*: a role or API from section 2 is missing. Fix it and use *Re-run failed jobs*.
- *Eventarc permissions are still propagating*: wait a few minutes and re-run.

## 6. Publishing blog posts

After publishing a post in `/admin/blog`, run **Actions → Publish blog to production → Run workflow** on `main`. A normal deploy also rebuilds the blog.

## 7. Turning on appointments

Appointments are switched on with one GitHub variable. Until then production behaves exactly as in sections 1–6. With `ENABLE_APPOINTMENTS=true` the production workflows:

- build the first-party booking page at `/schedule` (replacing the Google Calendar embed), redirect `/book` there, and add the site-copy publishing hooks and customer accounts (`scripts/prepare-staging.mjs --production`);
- write `APPOINTMENTS_MODE=live` for Functions, so Stripe accepts **only live** keys, sessions and events, Checkout returns customers to `HOSTING_ORIGIN`, and appointment emails go to customers instead of only the test inboxes;
- deploy the 5-minute `appointmentMaintenance` job and the Storage rules in `storage.rules` (blog images and job photos);
- smoke-test the booking page, the appointment API and the Stripe webhook.

Staging and the emulators always stay in test mode, so a test key can never run production and a live key can never run staging.

Do every step below before setting the variable.

### 7a. Google Cloud (project `niemansdetailing`)

- Enable **Secret Manager**, **Google Calendar API** and **Cloud Scheduler** under APIs & Services.
- Give the deploy service account **Cloud Scheduler Admin** (`roles/cloudscheduler.admin`) and **Firebase Rules Admin** if it lacks it (Storage rules).
- Give the Functions runtime account (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`) **Secret Manager Secret Accessor** on each of the three secrets below.
- For job photos and blog uploads, Storage rules read the Firestore admin list. Grant `roles/firebaserules.firestoreServiceAgent` to `service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com`.
- **Storage rules are replaced on deploy.** Open Firebase console → Storage → Rules first. If it has rules for paths other than `blog-images/` and `job-photos/`, add them to `storage.rules` before turning appointments on.

### 7b. Secrets in production Secret Manager

Create each as a secret with one version whose value is the JSON shown.

| Secret | Payload | Where to get it |
| --- | --- | --- |
| `APPOINTMENT_STRIPE_CONFIG` | `{"secretKey":"rk_live_…","webhookSecret":"whsec_…"}` | Restricted key from 7c and the signing secret from 7d. A full `sk_live_` key also works, but the restricted key is safer. |
| `APPOINTMENT_GOOGLE_CONFIG` | `{"clientId":"…","clientSecret":"…","refreshToken":"…","detailingId":"…","personalId":"…","plutoId":"…"}` | An OAuth client (type Web) in the production project, authorized with offline access for `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.events.freebusy` by the owner of your real calendars. **Publish the OAuth consent screen to production**, or the refresh token expires after 7 days. Calendar IDs are under each calendar's Settings → Integrate calendar. Set them to America/New_York. |
| `APPOINTMENT_EMAIL_CONFIG` | `{"apiKey":"re_…","from":"Nieman's Detailing <appointments@niemansdetailing.com>"}` | Resend: add and verify the `niemansdetailing.com` domain (it gives you DNS records to add), then create an API key with sending access. `testRecipients` is not needed in production. |

### 7c. Stripe restricted key

In the Stripe Dashboard switch to **live mode**, then Developers → API keys → **Create restricted key**. Set:

| Resource | Permission | Used for |
| --- | --- | --- |
| Checkout Sessions | **Write** | Create deposit and balance checkouts, read them back and find a session after a retry |
| Refunds | **Write** | Issue deposit refunds and check their status |
| Charges | **Read** | Confirm refunds reported by the webhook |
| Disputes | **Read** | Confirm dispute events |
| PaymentIntents | **Read** | Match a payment to its appointment |

Leave everything else at **None**. Line items are created inline, so Products and Prices are not needed. The webhook is created in the Dashboard, so Webhook Endpoints is not needed.

Also finish account activation, add the payout bank account, and turn on the payment methods you want under Settings → Payment methods.

### 7d. Stripe live webhook

Developers → Webhooks → **Add destination**:

- Endpoint URL: `https://niemansdetailing.com/api/appointments/stripe-webhook`
- API version: `2026-10-28.endive`, snapshot events
- Events: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`

Copy its signing secret (`whsec_…`) into `webhookSecret`.

### 7e. Firebase Authentication

Enable **Email/Password** with **Email link (passwordless sign-in)** for customer accounts, alongside Google. The authorized domains from section 3 already cover the site.

### 7f. Turn it on

1. In GitHub, set the `production` environment variable **`ENABLE_APPOINTMENTS`** to `true`.
2. Run **Actions → Deploy production** on `main` (or merge the next change).
3. In `/admin/appointments` → **Settings**, enter your real hours, ZIP codes and services, then enable public booking. The booking page shows availability only once Stripe and Calendar are both configured and booking is enabled.
4. Make one real booking with a small deposit on your own card, check it in Stripe, your Detailing calendar and your inbox, then cancel it and confirm the refund.

To turn appointments off again, set the variable back to `false` and redeploy. The scheduled job stays deployed but does nothing while appointments are off.
