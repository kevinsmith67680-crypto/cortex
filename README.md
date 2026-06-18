# Retain — Book Retention Quiz

Search any published book, or paste your own notes, and take an AI-generated
multiple-choice quiz that tests how much you actually remember. Earn XP, climb
ranks, build a library, and let spaced repetition resurface what you're about
to forget.

## Features
- **Book search** via Open Library (~40M titles, free, no key)
- **Quiz generation** via the Claude API with web search, so even recent or
  obscure books get accurate, grounded questions — and an honest refusal when
  reliable detail can't be found, instead of invented facts
- **Notes mode** — paste your own highlights/notes and get a quiz built strictly
  from them; works for any book, including brand-new ones
- **XP & ranks** — 100 XP per correct answer, perfect-quiz bonuses, ten ranks
- **Library** — every book you quiz, with score history and a stats dashboard
- **Spaced repetition** — missed questions come back for review on a schedule
  (these review quizzes reuse stored questions, so they cost nothing in API)
- **Review-the-misses** — retry just the questions you got wrong
- **Streaks & achievements** — daily streak tracking and unlockable badges
- **Difficulty & length** — easy/standard/hard, 5/8/12 questions
- **Dark theme**, **native share sheet**, and **haptics** (on device)
- Bottom tab bar: Home · Library · Notes · Settings

## Requirements
- Node.js 18+ (no packages needed to run the server)
- An Anthropic API key

## Run locally
1. `cp .env.example .env` and paste your key after `ANTHROPIC_API_KEY=`
   (create one at https://console.anthropic.com/ → Settings → API keys)
2. Enable web search for your org in the Anthropic Console (one-time)
3. `npm start`, then open http://localhost:3000

## Deploy + iOS app
See `DEPLOY.md` for putting the server on Render and wrapping the frontend in
Capacitor for the App Store.

## Privacy
Everything (XP, library, streak, saved notes, settings) is stored on-device in
the browser/app via localStorage. Only the book title or notes you choose to
quiz are sent to your server and to Anthropic to generate questions.

## Configuration (.env)
- `ANTHROPIC_MODEL` — defaults to `claude-sonnet-4-5`
- `PORT` — defaults to `3000`
- `RATE_HOURLY` / `RATE_DAILY` — per-IP quiz caps (defaults 10 / 40)

## Notes on cost
Each book quiz is one API call plus any web searches (billed per search).
Notes-mode and spaced-repetition reviews use no web search. Longer/harder
quizzes use more tokens. Budget a few cents per book quiz.
