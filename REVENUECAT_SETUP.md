# RevenueCat setup for Cortex

The app code is already wired for RevenueCat. This guide covers the account,
store, and dashboard steps only you can do, and exactly where each value goes.
Until you finish these, the app stays in **test mode** (the plan buttons switch
tiers locally so you can try the flow, but nobody is charged).

## What's already done in the code
- `@revenuecat/purchases-capacitor` is in `package.json`.
- The SDK is configured on launch with your account id (`subAcctId()` — the
  Supabase user id when signed in, otherwise a stable device id).
- The Manage subscription page loads live store prices, the **Choose** buttons
  run a real purchase, there's a **Restore purchases** button, and the required
  auto-renew / Terms / Privacy disclosures are shown.
- Entitlements map to tiers and drive the existing book/notes/review limits.
- `server.js` exposes `/api/rc-webhook` and, once `RC_WEBHOOK_AUTH` is set, trusts
  ONLY RevenueCat-verified entitlements (the client tier is ignored).

## 1. Create products in the stores
**App Store Connect** and **Google Play Console**: create two auto-renewing
monthly subscriptions and note their product IDs, e.g.
`cortex_pro_monthly` ($4.99) and `cortex_unlimited_monthly` ($9.99).

## 2. RevenueCat dashboard
1. Create a project and add your iOS and Android apps.
2. Create two **Entitlements** with identifiers **`pro`** and **`unlimited`**.
   (These must match `RC_ENTITLEMENTS` in `index.html` and `RC_ENT_TIER` in `server.js`.)
3. Create **Products** linked to the store product IDs from step 1, and attach
   each to its entitlement (pro product → `pro`, unlimited product → `unlimited`).
4. Create an **Offering** (e.g. "default") with two **Packages** whose identifiers
   are **`pro_monthly`** and **`unlimited_monthly`** — these must match `RC_PACKAGES`
   in `index.html`. (Or change `RC_PACKAGES` to whatever you name them.)

## 3. Paste your public SDK keys
In `public/index.html`, near the top:
```js
const RC_APPLE_API_KEY  = "appl_xxxxxxxxxxxxxxxxxxxx";   // RevenueCat → API keys
const RC_GOOGLE_API_KEY = "goog_xxxxxxxxxxxxxxxxxxxx";
```
These are the **public** SDK keys and are safe to ship. Leaving them blank keeps
test mode on.

## 4. Turn on server-side verification
1. Pick a long random string as a shared secret.
2. Set `RC_WEBHOOK_AUTH` to that value in Render's environment (and in `.env`
   locally if testing).
3. In RevenueCat → Project settings → **Webhooks**, add your server URL
   `https://YOUR-RENDER-URL/api/rc-webhook` and set the **Authorization** header
   to the same secret.

Once the secret is set, the server stops trusting the client's claimed tier and
honors only what RevenueCat confirms. Free users (no entitlement) simply get the
free limits.

## 5. Build & test
```
npm install
npx cap sync ios
```
Test purchases with a sandbox Apple ID (App Store) or a license-tester account
(Google Play). After a sandbox purchase, the tier should update automatically and
the higher limits should apply.

## Notes
- The verified-entitlement store and the monthly counters in `server.js` are
  in-memory; they reset on restart and when the free Render tier sleeps. Move both
  to a database (Supabase works) before relying on them at scale.
- This app ships a static `public/` with no bundler, so the SDK is accessed via
  the Capacitor bridge (`window.Capacitor.Plugins.Purchases`). If you adopt a build
  step, you can instead `import { Purchases } from "@revenuecat/purchases-capacitor"`;
  verify the method names if you do.
- Reviews never reach the server, so their monthly limit is enforced client-side
  only (they cost nothing, so this is a product limit, not a billing one).
