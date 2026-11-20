# Production setup

Everything to check before the first production deploy from `main`. Production is the Firebase project `niemansdetailing`, served at `https://niemansdetailing.com`. Staging setup lives in [firebase-staging-setup.md](firebase-staging-setup.md).

There are two stages:

1. **First production run** (sections 1–6). The current site, quote intake, Telegram alerts, admin, blog and the new UI. Appointments, deposits and customer email stay off.
2. **Turning on appointments** (section 7). Live Stripe, Calendar and email. This needs code changes as well as keys, so it is a separate launch.

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

The Firebase web key (`AIzaSyBgUnt…` in `firebase-config.mjs`) is a different key. If you restrict it, allow the same production domains and keep Identity Toolkit, Token Service, Firestore and Firebase Installations APIs allowed, or sign-in breaks.

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

## 7. Turning on appointments (later)

`ENABLE_APPOINTMENTS=true` turns on the appointment API and deploys the 5-minute `appointmentMaintenance` job. **It does not make live booking work yet.** The code is deliberately locked to test mode, and these must change in code before taking real deposits:

- `functions/appointment-stripe.ts`: only accepts `sk_test_`/`rk_test_` keys.
- `functions/appointments.ts` (`openCheckout`, `checkoutOrigin`): rejects live Checkout sessions and only allows a `<project>.web.app` origin.
- `functions/appointment-email.ts`: only emails addresses in `testRecipients`.
- Production `public/schedule.html` is still the Google Calendar booking embed. The first-party booking page, `/book` redirects and site-copy publishing are only built by `scripts/prepare-staging.mjs`, and production `firebase-config.mjs` has `appointmentsPreview = false`.

When that work is done, the production setup mirrors staging:

**Production Secret Manager** (project `niemansdetailing`). Enable Secret Manager, Google Calendar API and Cloud Scheduler. Grant the Functions runtime account **Secret Manager Secret Accessor** on each secret.

| Secret | Payload | Where to get it |
| --- | --- | --- |
| `APPOINTMENT_STRIPE_CONFIG` | `{"secretKey":"sk_live_… or rk_live_…","webhookSecret":"whsec_…"}` | Stripe Dashboard in **live mode** → Developers → API keys. A restricted key needs write access to Checkout Sessions and Refunds. The webhook secret comes from the endpoint below. |
| `APPOINTMENT_GOOGLE_CONFIG` | `{"clientId","clientSecret","refreshToken","detailingId","personalId","plutoId"}` | An OAuth client (Web) in the production project, authorized with offline access for `calendar.events` and `calendar.events.freebusy` by the owner of your real calendars. **Publish the OAuth consent screen to production**, or the refresh token expires after 7 days. Calendar IDs are in each calendar's settings. |
| `APPOINTMENT_EMAIL_CONFIG` | `{"apiKey":"re_…","from":"Nieman's Detailing <appointments@niemansdetailing.com>","testRecipients":[…]}` | Resend: verify the `niemansdetailing.com` domain (DNS records), then create a sending API key. |

**Stripe live webhook:** Developers → Webhooks → Add destination `https://niemansdetailing.com/api/appointments/stripe-webhook`, API version `2026-10-28.endive`, snapshot events: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`. Copy its signing secret into `webhookSecret`. Also finish account activation, payout bank account, and enable the payment methods you want under Settings → Payment methods.

**Firebase Auth:** enable Email/Password with Email link sign-in (customer accounts).

**GitHub:** set the `production` environment variable `ENABLE_APPOINTMENTS` to `true`, and give the deploy account Cloud Scheduler Admin (section 2).
