# Going live: Render deployment + iOS app wrap

Two stages. Stage 1 puts the quiz server on the internet (needed regardless of
platform). Stage 2 wraps the frontend into a real iOS app with Capacitor.

---

## Stage 1 — Deploy the server to Render

Render runs `server.js` in the cloud so the iOS app (and anyone) can reach it.

1. **Put this folder in a Git repo** (Render deploys from GitHub/GitLab):
   ```
   git init
   git add .
   git commit -m "Retain quiz app"
   ```
   Push it to a new GitHub repository (private is fine). IMPORTANT: never
   commit your `.env` file — add a `.gitignore` containing `.env` first
   (one is included in this folder).

2. **Create the Render service**
   - Sign up at https://render.com (free tier is fine to start)
   - New → **Blueprint** → connect your GitHub repo
   - Render reads `render.yaml` and sets everything up automatically
   - When prompted, paste your Anthropic API key as the value for
     `ANTHROPIC_API_KEY` (this replaces the local `.env` file — Render's
     environment variables are the cloud equivalent)

3. **Note your URL.** Render assigns something like
   `https://retain-quiz.onrender.com`. Open it in a browser — the quiz app
   should load and work, exactly like localhost did.

### Things to know about the free tier
- The service **sleeps after ~15 minutes idle** and takes ~30–60 seconds to
  wake on the next request. Fine for testing; upgrade to a paid instance
  (~$7/month) before real users arrive, or the first quiz of the day will
  feel broken.
- Rate limits are built in: 10 quizzes/hour and 40/day per IP address
  (change via the `RATE_HOURLY` / `RATE_DAILY` environment variables in the
  Render dashboard). This caps your worst-case API bill.

---

## Stage 2 — Wrap the frontend in Capacitor (requires a Mac)

### One-time setup
1. Install **Xcode** from the Mac App Store (large download), open it once
   and accept the license.
2. Install **Node.js** if not present (you already have it from local dev).
3. Install CocoaPods if Xcode asks for it later: `sudo gem install cocoapods`

### Point the app at your server
4. Open `public/index.html` and set the constant at the top of the script:
   ```js
   const API_BASE = "https://retain-quiz.onrender.com";   // your Render URL
   ```
   (No trailing slash.) The web version served by Render ignores this if
   you keep a separate copy — simplest is to set it and redeploy; the web
   version works fine with an absolute URL too.

### Build the iOS project
5. From the project folder:
   ```
   npm install
   npx cap add ios
   npx cap sync ios
   npx cap open ios
   ```
   This installs Capacitor, generates a native Xcode project in `ios/`,
   copies your `public/` files into it, and opens Xcode.

6. **In Xcode:**
   - Select the `App` target → *Signing & Capabilities* → choose your team
     (your Apple ID works for free on-device testing; App Store
     distribution needs the $99/year Apple Developer Program)
   - Change the Bundle Identifier to something you own, matching
     `appId` in `capacitor.config.json` (e.g. `com.yourname.retain`)
   - Pick your plugged-in iPhone or a Simulator from the device menu
   - Press **Run** (▶)

   The app should launch, search books, and generate quizzes through your
   Render server. localStorage (XP, asked-question memory) persists inside
   the app, and the native share sheet works via the Share… button.

### Every time you change the frontend
```
npx cap sync ios
```
then Run again from Xcode. (Server changes deploy via `git push` — Render
auto-redeploys.)

### App icon and splash screen
Generate them from a single 1024×1024 image:
```
npm install -D @capacitor/assets
npx capacitor-assets generate --ios
```
(Put your source image at `assets/icon.png` first.)

---

## Toward the App Store
- Join the Apple Developer Program ($99/year) at https://developer.apple.com
- In Xcode: Product → Archive → Distribute App → App Store Connect
- Set up the listing at https://appstoreconnect.apple.com — screenshots,
  description, privacy policy URL, and the App Privacy questionnaire
  (declare: book titles are sent to your server and to Anthropic to
  generate quizzes; no personal data is collected)
- Use **TestFlight** for beta testing before submitting for review
- Guideline to respect: 4.2 (minimum functionality) — your leveling system,
  share sheet, and offline-aware UI help the app feel native rather than
  like a wrapped website

## Troubleshooting
- **App shows "no server configured"** — you didn't set `API_BASE` before
  `npx cap sync ios`.
- **First quiz of the day hangs ~45s** — Render free tier waking up;
  upgrade the instance or accept it during testing.
- **429 "hit the quiz limit"** — the rate limiter; raise `RATE_HOURLY` /
  `RATE_DAILY` in Render's environment settings.
- **CORS errors in Xcode console** — make sure you're on the updated
  `server.js` (it sends Access-Control-Allow-Origin headers and answers
  OPTIONS preflights).
