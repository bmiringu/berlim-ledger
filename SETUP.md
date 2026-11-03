# Berlim Homes Rent Ledger: stand-alone setup (Firebase)

This folder is the complete website. Firebase project: **berlim-homes-ltd**.

## What's inside

| File | What it is |
|---|---|
| `public/index.html` | The ledger: same screens and reports as the Claude version, plus a login screen |
| `public/firebase-shim.js` | Connects the ledger to Firebase: sign-in, records, uploads, downloads |
| `public/config.js` | Your Firebase web settings and the administrator email list |
| `firestore.rules`, `storage.rules` | Security: only signed-in team members can read or change anything |
| `firebase.json`, `.firebaserc` | Hosting settings for the `firebase deploy` command |

## 1. Finish the settings (2 minutes)

1. Firebase console → ⚙ **Project settings** → **Your apps**. If there is no web app yet, click **</>** and register one (name: Berlim Ledger).
2. Copy `apiKey` and `appId` into `public/config.js` (replace `PASTE_API_KEY_HERE` and `PASTE_APP_ID_HERE`).
   These two values identify the project; they are not passwords. Security comes from the rules files.
3. `ADMIN_EMAILS` in `public/config.js` lists the logins that are always administrators (now `berlimhomes@gmail.com`).
   If you change it, make the same change in `adminEmails()` in `firestore.rules`.

## 2. Switch on the Firebase services

1. **Authentication** → Get started → **Email/Password** → Enable → Save.
   Then **Users** → **Add user**: `berlimhomes@gmail.com` with a strong password. This is the first administrator login.
2. **Firestore Database** → Create database → **Production mode** → choose a location (e.g. `europe-west1`, or `africa-south1` Johannesburg). The location can't be changed later.
3. **Storage is optional.** The ledger runs on the free **Spark** plan without it (no card needed).
   Without Storage, meter photos, uploading signed agreements and PDF download links are switched off;
   PDFs can still be downloaded and attached on WhatsApp.
   To add Storage later: upgrade to **Blaze**, open **Storage** → Get started, set `STORAGE_ON = true` in `public/config.js`,
   add `"storage": { "rules": "storage.rules" }` to `firebase.json`, and run `firebase deploy` again.

## 3. Publish the website (once, then after each update)

On any computer with internet:

```bash
# install once
#   Node.js from https://nodejs.org (LTS), then:
npm install -g firebase-tools
firebase login                 # sign in with berlimhomes@gmail.com

# in this folder
firebase deploy                # publishes the site and both rules files
```

The site is then live at **https://berlim-homes-ltd.web.app**.

## 4. Use your own address (optional)

1. Firebase console → **Hosting** → **Add custom domain** → `ledger.berlimhomes.com`.
2. Add the DNS records Firebase shows at the company that manages berlimhomes.com. The SSL certificate is issued automatically (can take a few hours).
3. **Authentication** → **Settings** → **Authorized domains**: make sure `ledger.berlimhomes.com` is listed.

## 5. Move your records

1. In the **Claude version** of the ledger: **Admin** → **Back up or move records** → **Export all records**. A `.json` file downloads.
2. In the **new site**, signed in as administrator: **Admin** → **Import records file** → choose that file.
   About 2,000+ records import in under a minute. Running it again is safe (records are overwritten, not duplicated).

Meter photos and signed agreements uploaded in the Claude version stay there; upload any you need again in the new site.

## 6. Add your team

**Admin** → **Add a team member**: name, email, a starting password and a role
(Administrator, Property manager, Accountant, Field officer / caretaker, View only).
Tick whether their payments, reversals, tenant changes and provider payments need your approval.
Give them the password privately; they can change it with **Forgot password?** on the login screen.

To remove someone: **Admin** → **Team** → **Remove**. To stop them signing in at all, also disable the user in Firebase → Authentication → Users.

## Good to know

- Who can do what (payments, invoices, readings…) is enforced by the app; the security rules make sure only your team members can reach the data at all.
- Statement links sent to tenants are private download links: anyone with the link can open that one PDF, so send it only to the tenant.
- Each sign-in loads all records (about 2,500 today). Firestore's daily free allowance covers many sign-ins a day for an office your size.
- To update the site later, replace `public/index.html` with the new version and run `firebase deploy` again.
