# Firebase staging setup

Create a separate Firebase project for the staging branch. The workflow publishes to the default Hosting site at `https://<staging-project-id>.web.app`.

## Firebase Console

| Setting | Value |
| --- | --- |
| Project name | `Nieman's Detailing Staging` |
| Project ID | Try `niemansdetailing-staging`. If Firebase assigns a suffix, use the exact resulting ID throughout this guide. |
| Billing plan | **Blaze**, required for Functions deployment and a new default Storage bucket. |
| Google Analytics | Off for staging. |
| Cloud Firestore | Create the `(default)` database in Native mode using the **Standard** edition and production mode. Choose `us-east1` (South Carolina), the region used by the Functions. |
| Cloud Storage | Create the default bucket in `us-east1` with production rules. Use the exact bucket name Firebase gives you. |
| Authentication | Enable the Google provider and select your support email. Verify that `<staging-project-id>.web.app` is listed under authorized domains. |
| Web app | Project settings → General → Your apps → Add app → Web. Name it `Detailing Staging Web`. Use the default Hosting site if prompted. |

After registering the web app, open **SDK setup and configuration → Config**. Paste the `const firebaseConfig = {...};` object snippet or copy its values into a JSON object with double-quoted keys and strings. Use the real values from the console. If the web config lacks `storageBucket`, copy the bucket name from Storage without the `gs://` prefix.

```json
{
  "apiKey": "COPY_FROM_STAGING_WEB_APP",
  "authDomain": "niemansdetailing-staging.firebaseapp.com",
  "projectId": "niemansdetailing-staging",
  "storageBucket": "niemansdetailing-staging.firebasestorage.app",
  "appId": "COPY_FROM_STAGING_WEB_APP"
}
```

The web app SDK config is public client configuration. The deployment service account key is a separate credential.

## Google Cloud Console for the same staging project

Create the default bucket in Firebase Console under **Storage** and verify the [Cloud Storage for Firebase API](https://console.cloud.google.com/apis/library/firebasestorage.googleapis.com?project=niemansdetailing-staging) is enabled. The GitHub deployment account uses enabled services and cannot turn on a disabled API.

Under **APIs & Services → Library**, enable Cloud Functions, Cloud Run Admin, Cloud Build, Artifact Registry, Eventarc, and Pub/Sub. Firebase enables the Firebase product APIs during setup. If the CLI reports a disabled API, enable the one it names in this project and rerun the workflow.

Under **IAM & Admin → Service Accounts**, create `github-staging-deploy`. Grant it these staging project roles in IAM:

| Role | Role ID |
| --- | --- |
| Firebase Viewer | `roles/firebase.viewer` |
| Firebase Hosting Admin | `roles/firebasehosting.admin` |
| Firebase Rules Admin | `roles/firebaserules.admin` |
| Cloud Datastore Index Admin | `roles/datastore.indexAdmin` |
| Cloud Functions Admin | `roles/cloudfunctions.admin` |
| Eventarc Admin | `roles/eventarc.admin` |
| Service Usage Consumer | `roles/serviceusage.serviceUsageConsumer` |

Grant the deployer **Service Account User** (`roles/iam.serviceAccountUser`) on the runtime and build service accounts used in this project. On a new project they commonly both use `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`. Find the project number under Firebase Project settings → General. If Cloud Build uses a different default service account, grant the deployer access to that account too.

Grant the Functions runtime account **Cloud Datastore User** (`roles/datastore.user`) for Firestore reads/writes and **Eventarc Event Receiver** (`roles/eventarc.eventReceiver`) for the Firestore trigger. Grant the Cloud Build account **Cloud Build Service Account** (`roles/cloudbuild.builds.builder`) if it lacks build permissions. Verify the Firestore trigger's identity can invoke its Cloud Run service with **Cloud Run Invoker** (`roles/run.invoker`) if the first deploy reports an invocation permission error. [Google's first deployment build account guidance](https://docs.cloud.google.com/functions/docs/building) · [Eventarc roles](https://docs.cloud.google.com/eventarc/standard/docs/functions/roles-permissions)

For staging blog image uploads, Storage Rules check the Firestore admin list. Grant `roles/firebaserules.firestoreServiceAgent` in the staging project to `service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com`. The Storage service account is created when the bucket is provisioned. [Firebase cross-service rules](https://firebase.google.com/docs/rules/manage-deploy)

Generate a JSON key under `github-staging-deploy` → **Keys → Add key → Create new key → JSON** and put its contents directly into the GitHub environment secret below. If your organization blocks service account keys, this workflow needs to be configured for Workload Identity Federation before deployment.

## GitHub repository settings

Create an environment named **`staging`** under **Settings → Environments**. Restrict its deployment branches to `staging` where the repository plan supports it. Add these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `STAGING_FIREBASE_PROJECT_ID` | Exact staging project ID. |
| Variable | `STAGING_FIREBASE_WEB_CONFIG` | JSON or the Firebase Web SDK config object snippet. |
| Secret | `STAGING_FIREBASE_SERVICE_ACCOUNT` | Contents of the JSON key for `github-staging-deploy`. |

The workflow runs on pushes to `staging`. Once the workflow also exists on the default branch, you can run it manually from Actions by selecting the `staging` branch. The workflow verifies that the web app settings and deploy key match the staging project ID. It deploys the Functions, Firestore indexes/rules and Storage rules before building the blog from staging Firestore and releasing Hosting. Production deploys from `main`.

## First staging check

1. Open `https://<staging-project-id>.web.app/admin`, sign in with Google, and copy your UID from **Authentication → Users** in Firebase Console. The dashboard will show Access Denied until you add the next document.
2. In staging Firestore, create the `adminUsers` collection and a document whose ID equals that UID. A field such as `label: "Nieman"` is fine. Access is granted by the document ID. Refresh `/admin`.
3. Submit a synthetic quote at `/quote` and confirm it appears in staging admin and Firestore. Exercise `/ceramic-quote` and `/thank-you` too. Telegram delivery is disabled in staging.
4. Verify `/schedule` points to `/book` and `/account`. The live Google booking embed is excluded from the staging bundle.
5. Optionally create a test blog post with a sample cover image. Staging's static blog reflects published posts after the next staging deploy.

The workflow also checks the staging SDK config, `/quote`, `/schedule`, `/admin/appointments`, and intentionally unauthorized or invalid API requests. Hosting sends `X-Robots-Tag: noindex, nofollow`. The staging URL itself is public, so use synthetic customer details and media.

## Test owner appointments

1. Open `/admin/appointments` or choose **Create appointment** from a test lead or client. A linked record prefills contact information, quote details, and the client’s deposit preference when available.
2. Select **No deposit required** and confirm a future appointment. The site checks all three calendars. For a client record, **Save as this client's default** applies the preference to future owner-created appointments. For a deposit-required entry, save the draft and choose **Hold time and generate deposit link** after configuring Stripe test mode.
3. Generate a customer link and open it in a private browser window. Confirm the Eastern time, address, estimate, and Add to calendar options. **Text link** and **Email link** open a message in your device’s messaging or email app for you to send.
4. Create a second appointment that overlaps the first. It should be rejected. Cancel the first and check that its link shows the cancellation and the slot can be booked again. Generate a replacement link to invalidate the previous one, or choose **Revoke link** to remove access. Share links expire 30 days after the appointment ends.

If any configured calendar is unavailable, owner drafts and quote intake remain available. New reservations, confirmations, and moves resume when availability checks succeed. CI tests the standalone reservation and approval logic in Firebase emulators and checks deployed pages and API responses after deployment.

## Connect the staging integrations

The existing GitHub deploy variables and service account deploy Firebase. Store the following integration credentials in **Secret Manager in the staging Google Cloud project**. Grant the **Functions runtime service account** Secret Manager Secret Accessor (`roles/secretmanager.secretAccessor`) on each named secret. This differs from the GitHub deploy account. Enable Secret Manager, Google Calendar API, and Cloud Scheduler. Grant the deployer Cloud Scheduler Admin (`roles/cloudscheduler.admin`) in the staging project so it can deploy the recurring reconciliation job. Do not copy live Stripe keys, production customer records, or live calendars into staging.

| Secret name | JSON payload |
| --- | --- |
| `APPOINTMENT_STRIPE_CONFIG` | `{"secretKey":"sk_test_…","webhookSecret":"whsec_…"}` |
| `APPOINTMENT_GOOGLE_CONFIG` | `{"clientId":"…","clientSecret":"…","refreshToken":"…","detailingId":"…","personalId":"…","plutoId":"…"}` |
| `APPOINTMENT_EMAIL_CONFIG` | `{"apiKey":"re_…","from":"Detailing Staging <staging@example.test>","testRecipients":["your-test-inbox@example.com"]}` |

- **Stripe**. Use Stripe test mode or a sandbox. Add the event destination `https://<staging-project-id>.web.app/api/appointments/stripe-webhook` for `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed`. Use snapshot events and the matching endpoint signing secret. API calls pin `2026-10-28.endive`. The app rejects live keys and live events. The staging UI uses hosted Checkout. [Stripe Checkout API](https://docs.stripe.com/api/checkout/sessions/create) · [Webhook destinations](https://docs.stripe.com/events/set-up-events)
- **Calendar**. Authorize an OAuth client with offline access using the owner of three dedicated test calendars. Request `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.events.freebusy`. Use the returned refresh token and each calendar's ID from Calendar settings. Only the staging Detailing calendar gets mirror writes. Set calendar time zones to America/New_York. Test configuration manually expires if your Google consent app is in testing and the refresh token expires. [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) · [Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- **Email**. Provide a Resend test key and an allowed sender for the account. Use only test inboxes in `testRecipients`. Email is optional if sharing links manually. The scheduled worker retries delivery. [Resend API](https://resend.com/docs/api-reference/emails/send-email)
- **Firebase Auth**. Enable Email/Password and Email link sign-in alongside Google. Add the staging Hosting domain to authorized domains. Open customer links in a private window so the test does not sign the admin out. [Firebase email-link authentication](https://firebase.google.com/docs/auth/web/email-link-auth)

After setup, save business hours, ZIPs, and services under **Business hours and online booking** in `/admin/appointments`. For a synthetic Full Detail test use a line such as `full | Full Detail | 180 | 300.00` and choose the weekdays and time range you want to test. Enable public booking after the Stripe and Calendar credentials are configured.

## Staging acceptance checks

1. Complete a normal test-card deposit from an owner-generated link and verify direct confirmation. Check the $50 receipt in Stripe and the appointment in the staging Detailing calendar.
2. Book from `/quote` → `/thank-you` → `/book`, pay the deposit, then approve the request. Block part of a test day separately on each calendar and verify those times do not appear.
3. Cancel an unapproved paid request and an approved request with at least 96 hours' notice. Check that the test refund reaches Stripe. Cancel another confirmed request inside 96 hours and verify the deposit is retained. Reschedule an inside-cutoff job and verify a later cancellation still retains it.
4. Close a test job. Confirm that the approved final total deducts any deposit. Record and reverse a cash payment, then pay a remaining balance with a test card. Export the ledger and compare each payment and refund to Stripe.
5. Save a customer appointment to an account after verifying the same email. Sign in using email link and Google, try a different account, and check that it cannot claim the appointment.
6. Select the optional maintenance email at closeout for a Full Detail with a test email address. Check that a partial payment or uncleared check does not send it and that full settlement queues it once. Test manually creating an invitation for a different fully paid job, then request enrollment. Verify the 60-day cutoff and that giving consent does not start automatic billing.
7. Save a CMS draft, verify the public page is untouched, then publish and restore a revision. Use a test editor with `role: "editor"` and verify it cannot read appointments or change payment records.
8. Install the admin app from Android Chrome and launch it. Turn off networking, check the offline page, then reconnect and verify the app reloads appointments.
