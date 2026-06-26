// Book Retention Quiz — local server (zero dependencies, Node 18+)
// Serves the frontend and handles quiz generation via the Claude API.
// The API key stays here on the server and is never exposed to the browser.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dotenv dependency) -------------------------------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

// --- rate limiting (the server is public once deployed; every quiz costs money) ---
// Per-IP: 10 quizzes/hour, 40/day. In-memory — resets on restart, fine for this scale.
const RATE_HOURLY = parseInt(process.env.RATE_HOURLY || "10", 10);
const RATE_DAILY = parseInt(process.env.RATE_DAILY || "40", 10);
const hits = new Map(); // ip -> array of timestamps

// --- subscription entitlement (per-account monthly book-quiz counter) ---------
// Only BOOK quizzes (the web-search path that costs money) are metered. Notes
// quizzes and spaced-repetition reviews are never counted.
// NOTE: `tier` is asserted by the client here. Before launch, verify the tier
// server-side from an App Store / Google Play receipt (e.g. a RevenueCat webhook)
// so it can't be spoofed. The counter is in-memory and resets on restart / when
// the free Render instance sleeps — move it to a database for durable enforcement.
const PLAN_LIMITS = {
  free:      { book: 3,        notes: 5 },
  pro:       { book: 30,       notes: Infinity },
  unlimited: { book: Infinity, notes: Infinity },
};
const counts = new Map(); // `${acctId}:${kind}:${YYYY-MM}` -> count
const monthKey = () => new Date().toISOString().slice(0, 7);
const usedCount = (acctId, kind) => counts.get(acctId + ":" + kind + ":" + monthKey()) || 0;
function incCount(acctId, kind) {
  const k = acctId + ":" + kind + ":" + monthKey();
  counts.set(k, (counts.get(k) || 0) + 1);
  if (counts.size > 50_000) { const m = monthKey(); for (const key of counts.keys()) if (!key.endsWith(m)) counts.delete(key); }
}

// --- verified entitlements (fed by RevenueCat webhook) ------------------------
// When RC_WEBHOOK_AUTH is set, the server trusts ONLY entitlements confirmed by
// RevenueCat's webhook (the client-sent `tier` is ignored) — this is the secure,
// production setup. With no secret set (local/test mode), the client `tier` is
// trusted so the in-app test switch works. Store is in-memory; move to a database
// for durability. Map your RevenueCat entitlement identifiers to tiers here.
const RC_WEBHOOK_AUTH = process.env.RC_WEBHOOK_AUTH || "";
const RC_ENFORCED = !!RC_WEBHOOK_AUTH;
const RC_ENT_TIER = { unlimited: "unlimited", pro: "pro" };
const TIER_RANK = { free: 0, pro: 1, unlimited: 2 };
const verified = new Map(); // app_user_id -> { tier, exp }  (exp = ms epoch, 0 = no expiry)
function verifiedTier(acctId) {
  const v = verified.get(acctId);
  if (!v) return null;
  if (v.exp && Date.now() > v.exp) return "free";
  return v.tier;
}
function effectiveTier(acctId, clientTier) {
  if (RC_ENFORCED) return verifiedTier(acctId) || "free";
  return ["free", "pro", "unlimited"].includes(clientTier) ? clientTier : "free";
}


// --- FirstPromoter affiliate sales -----------------------------------------
// Keep the API key in Render/local environment variables; never ship it in
// public/index.html. The account id is not secret, but it is also read from env
// so production config lives in one place.
const FIRSTPROMOTER_API_KEY = process.env.FIRSTPROMOTER_API_KEY || "";
const FIRSTPROMOTER_ACCOUNT_ID = process.env.FIRSTPROMOTER_ACCOUNT_ID || "";
const FP_SALE_EVENTS = new Set(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"]);
const fpSaleEventsSeen = new Set();

function rcEmail(ev) {
  return ev?.subscriber_attributes?.$email?.value || ev?.subscriber_attributes?.email?.value || null;
}

function rcAmountInCents(ev) {
  const value = Number(
    ev?.price_in_purchased_currency ??
    ev?.price ??
    ev?.purchased_price ??
    0
  );
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

async function sendFirstPromoterSale(ev) {
  if (!FIRSTPROMOTER_API_KEY || !FIRSTPROMOTER_ACCOUNT_ID) {
    console.warn("[FirstPromoter] Missing FIRSTPROMOTER_API_KEY or FIRSTPROMOTER_ACCOUNT_ID; sale not sent.");
    return;
  }

  if (!FP_SALE_EVENTS.has(ev?.type)) return;

  const uid = ev.app_user_id || null;
  const email = rcEmail(ev);
  if (!uid && !email) {
    console.warn("[FirstPromoter] RevenueCat sale event had no app_user_id or email; sale not sent.");
    return;
  }

  const eventId = ev.transaction_id || ev.original_transaction_id || ev.id;
  if (!eventId) {
    console.warn("[FirstPromoter] RevenueCat sale event had no transaction/id; sale not sent.");
    return;
  }
  if (fpSaleEventsSeen.has(eventId)) return;
  fpSaleEventsSeen.add(eventId);
  if (fpSaleEventsSeen.size > 10000) fpSaleEventsSeen.clear();

  const body = {
    uid,
    email,
    event_id: eventId,
    amount: rcAmountInCents(ev),
    currency: ev.currency || ev.currency_code || "USD",
    plan: ev.product_id || ev.product_identifier || undefined,
  };
  Object.keys(body).forEach((k) => body[k] == null && delete body[k]);

  try {
    const fp = await fetch("https://api.firstpromoter.com/api/v2/track/sale", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FIRSTPROMOTER_API_KEY}`,
        "Account-ID": FIRSTPROMOTER_ACCOUNT_ID,
      },
      body: JSON.stringify(body),
    });
    const text = await fp.text();
    if (!fp.ok) {
      // A 404 usually means the user was not a referred lead in FirstPromoter.
      console.warn(`[FirstPromoter] Sale not accepted (${fp.status}): ${text}`);
    } else {
      console.log(`[FirstPromoter] Sale tracked for uid=${uid || "no-uid"}, event_id=${eventId}`);
    }
  } catch (err) {
    console.warn("[FirstPromoter] Sale request failed:", err.message);
  }
}

function clientIp(req) {
  // Render sits behind a proxy; the real client IP is first in x-forwarded-for.
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? String(fwd).split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 86_400_000);
  const lastHour = list.filter((t) => now - t < 3_600_000);
  if (lastHour.length >= RATE_HOURLY || list.length >= RATE_DAILY) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  // keep the map from growing forever
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < 86_400_000)) hits.delete(k);
  }
  return false;
}

// --- CORS: the iOS app's webview runs at capacitor://localhost, a different
// origin from the API, so cross-origin requests (and preflights) must be allowed.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Helper: pull a JSON object out of a model reply, tolerating markdown fences,
// preamble text, and a reply truncated mid-object (we repair unclosed JSON).
// ---------------------------------------------------------------------------
function parseModelJson(text) {
  let s = text.replace(/```json|```/g, "").trim();
  const start = s.indexOf("{");
  if (start === -1) throw new Error("no JSON found in model reply");
  s = s.slice(start);
  const end = s.lastIndexOf("}");
  if (end !== -1) {
    try { return JSON.parse(s.slice(0, end + 1)); } catch { /* fall through */ }
  }
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = s.replace(/,\s*$/, "");
  if (inStr) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) repaired += stack.pop();
  return JSON.parse(repaired);
}

// ---------------------------------------------------------------------------
// Quiz generation: calls Claude with the web search tool enabled, so books
// outside the model's built-in knowledge still get accurate, grounded quizzes.
// ---------------------------------------------------------------------------
// Angles we rotate through so repeat quizzes on the same book explore
// different territory instead of re-treading the most famous moments.
const ANGLES = [
  "secondary characters and their motivations",
  "the sequence and chronology of events",
  "cause-and-effect: why events happened, not just what happened",
  "settings, places, and objects that matter to the story or argument",
  "the opening third of the book, which quizzes often neglect",
  "the final third of the book and how things resolve",
  "relationships and conflicts between characters or ideas",
  "specific details a skimmer would miss but a reader would recall",
  "turning points and decisions that changed the direction of the book",
  "the book's themes, arguments, and what it is ultimately saying",
];

function pickAngles(n) {
  const pool = [...ANGLES];
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Difficulty is driven by the reader's GRADE on this book (F easiest → S hardest).
// The better you've performed, the harder the questions get.
const DIFF = {
  F: "The reader is new to this material. Ask the simplest, most fundamental recall questions only — the biggest plot points and the most prominent characters or ideas. Include two or three true/false questions (use exactly two options, \"True\" and \"False\"). Distractors should be obviously wrong to anyone who finished it.",
  D: "Easy. Ask about main events and central characters that any reader who finished the book would comfortably remember. Distractors clearly wrong on a moment's thought.",
  C: "Standard. A balanced mix of key events, important characters, and a few notable details and themes a careful reader would recall.",
  B: "Challenging. Focus on specific details, secondary characters, motivations, and the order of events — things a skimmer would miss but an attentive reader would catch.",
  A: "Hard. Probe subtle details, minor characters, cause-and-effect, thematic subtext, and easily-confused specifics. A reader who only half-remembers the book should struggle badly. Distractors should be close and tempting.",
  S: "Brutally, almost impossibly hard. Ask about the most obscure details, throwaway lines, minor names, precise sequences, and subtle thematic or structural nuance. Even a devoted reader should find these extremely difficult. Distractors must be devious and very nearly correct, differing only in a fine detail.",
};

async function handleQuiz(body) {
  const { title, author, year } = body || {};
  const mode = body?.mode === "notes" ? "notes" : "book";
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 16000) : "";
  const grade = ["F", "D", "C", "B", "A", "S"].includes(body?.difficulty) ? body.difficulty : "C";
  const count = Math.min(Math.max(parseInt(body?.count, 10) || 8, 3), 15);
  // Previously asked questions (sent by the client) — capped and sanitized.
  const avoid = Array.isArray(body?.avoid)
    ? body.avoid.filter((s) => typeof s === "string").slice(0, 60).map((s) => s.slice(0, 200))
    : [];
  // subscription entitlement inputs
  const clientTier = ["free", "pro", "unlimited"].includes(body?.tier) ? body.tier : "free";
  const acctId = (typeof body?.acctId === "string" && body.acctId.slice(0, 128)) || "anon";
  const tier = effectiveTier(acctId, clientTier);

  if (mode === "book" && !title) return { status: 400, json: { error: "Missing book title." } };
  if (mode === "notes" && notes.trim().length < 40) {
    return { status: 400, json: { error: "Please paste a bit more text — at least a few sentences of notes to build questions from." } };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 500, json: { error: "No API key configured. Copy .env.example to .env and add your ANTHROPIC_API_KEY." } };
  }

  // Entitlement: meter book and notes quizzes against the account's monthly plan limit.
  // (Reviews never reach the server; they're metered client-side.)
  {
    const limit = (PLAN_LIMITS[tier] || PLAN_LIMITS.free)[mode];
    if (limit !== undefined && usedCount(acctId, mode) >= limit) {
      const label = mode === "notes" ? "notes quizzes" : "book quizzes";
      return { status: 402, json: { limit: true, error: `You've used all ${limit} ${label} on the ${tier} plan this month. Upgrade or come back next month.` } };
    }
  }

  const diffNote = `\n- Difficulty (this reader has earned grade ${grade} on this material): ${DIFF[grade]}`;
  const avoidNote = avoid.length
    ? `\n\nThese questions were already asked — do NOT repeat them, closely paraphrase them, or test the same fact in different words:\n${avoid.map((q) => `- ${q}`).join("\n")}`
    : "";

  let prompt, useSearch;

  if (mode === "notes") {
    // Notes mode: quiz is built purely from the user's pasted text. No search,
    // no outside knowledge — accurate for any book, even ones the model can't know.
    useSearch = false;
    prompt = `A reader has pasted their own notes/highlights from something they read. Generate a retention quiz based STRICTLY on the content of these notes — do not add outside facts, and do not use anything not present or directly implied by the notes.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{"known": true, "questions": [{"question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "one short sentence"}]}

If the notes are too sparse or incoherent to build questions from:
{"known": false, "reason": "one sentence explaining this politely"}

Rules:
- Exactly ${count} questions drawn only from the notes below.
- Each question has exactly 4 options (or 2 for true/false) with exactly one correct answer. correctIndex is the 0-based index.
- Distractors must be plausible but clearly wrong to someone who absorbed the notes.
- Vary the position of the correct answer.
- Write everything in your own words; do not quote the notes verbatim beyond short unavoidable terms.${diffNote}${avoidNote}

The reader's notes:
"""
${notes}
"""`;
  } else {
    useSearch = true;
    const label = `"${title}" by ${author || "unknown author"}${year ? ` (first published ${year})` : ""}`;
    const angleNote = `\n- Emphasize these angles in this quiz: ${pickAngles(2).join("; ")}. At most 2 questions may fall outside these angles.`;
    prompt = `You are generating a retention quiz for someone who has just finished reading the published book ${label}.

Step 1 — assess your knowledge. If you already have solid, detailed knowledge of this specific book's actual content, you may write the quiz directly. If your knowledge is thin, uncertain, or you might be confusing it with another work, USE WEB SEARCH to find plot summaries, reviews, and discussion of the book's content before writing questions. Ground every question in what you actually know or found.

Step 2 — respond with ONLY a JSON object as your final answer, no markdown fences, no preamble, in exactly one of these shapes:

If you can write an accurate quiz (from knowledge or search):
{"known": true, "questions": [{"question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "one short sentence"}]}

If even after searching you cannot find enough reliable detail about this book's content:
{"known": false, "reason": "one sentence explaining this politely"}

Rules when known is true:
- Exactly ${count} questions testing genuine retention: key events, characters or central figures, important details, and one or two on themes or main arguments.
- Each question has exactly 4 options (or 2 for true/false) with exactly one correct answer. correctIndex is the 0-based index.
- Distractors must be plausible to someone who skimmed the book, but clearly wrong to someone who read it.
- Vary the position of the correct answer across questions.
- Write all questions and answers in your own words. Never reproduce passages or quotations from the book itself.
- No questions answerable without reading the book (e.g. not "who wrote it").
- Every fact must come from the actual book's content. Never guess or invent details.${diffNote}${angleNote}${avoidNote}`;
  }

  try {
    const reqBody = {
      model: MODEL,
      max_tokens: Math.min(8000, 1200 + count * 350),
      messages: [{ role: "user", content: prompt }],
    };
    if (useSearch) {
      reqBody.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    const data = await r.json();
    if (data.error) {
      const msg = data.error.message || "Claude API error";
      console.error("Claude API error:", msg);
      return { status: 502, json: { error: msg } };
    }

    // The reply interleaves text blocks with search-tool blocks; keep the text.
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = parseModelJson(text);

    if (!parsed.known) {
      return { status: 200, json: { known: false, reason: parsed.reason || null } };
    }

    const questions = (parsed.questions || []).filter(
      (q) =>
        q && q.question && Array.isArray(q.options) &&
        (q.options.length === 4 || q.options.length === 2) &&
        q.options.every((o) => typeof o === "string" && o.length) &&
        Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length
    );
    if (questions.length < 3) {
      return { status: 502, json: { error: "The generated quiz came back malformed. Please try again." } };
    }
    const searched = (data.content || []).some((b) => b.type === "server_tool_use");
    incCount(acctId, mode);
    return { status: 200, json: { known: true, questions, searched } };
  } catch (err) {
    console.error("Quiz generation failed:", err.message);
    return { status: 500, json: { error: "Quiz generation failed. Check the server logs and try again." } };
  }
}

// ---------------------------------------------------------------------------
// Minimal HTTP server: static files from public/, plus POST /api/quiz
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  // CORS preflight for the iOS app
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // health check (Render pings this to know the service is alive)
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // RevenueCat webhook: confirms purchases/renewals/expirations and updates the
  // verified entitlement for an app_user_id. Set RC_WEBHOOK_AUTH and configure the
  // same value as the Authorization header in the RevenueCat dashboard webhook.
  if (req.method === "POST" && req.url === "/api/rc-webhook") {
    if (!RC_WEBHOOK_AUTH || req.headers["authorization"] !== RC_WEBHOOK_AUTH) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const ev = (JSON.parse(raw || "{}").event) || {};
        const uid = ev.app_user_id;
        if (uid) {
          const ents = Array.isArray(ev.entitlement_ids) ? ev.entitlement_ids : (ev.entitlement_id ? [ev.entitlement_id] : []);
          let tier = "free";
          for (const e of ents) { const t = RC_ENT_TIER[e]; if (t && TIER_RANK[t] > TIER_RANK[tier]) tier = t; }
          const expiring = ["EXPIRATION", "BILLING_ISSUE"].includes(ev.type);
          if (expiring || tier === "free") verified.set(uid, { tier: "free", exp: 0 });
          else verified.set(uid, { tier, exp: ev.expiration_at_ms || 0 });
        }
        sendFirstPromoterSale(ev).catch((err) => console.warn("[FirstPromoter] Background sale tracking failed:", err.message));
      } catch (err) { console.warn("[RevenueCat] Malformed webhook:", err.message); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/quiz") {
    if (rateLimited(clientIp(req))) {
      res.writeHead(429, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: "You've hit the quiz limit for now (" + RATE_HOURLY + "/hour, " + RATE_DAILY + "/day). Take a reading break and come back soon." }));
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* leave empty */ }
      const { status, json } = await handleQuiz(body);
      res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify(json));
    });
    return;
  }

  // static
  const urlPath = req.url === "/" ? "/index.html" : (req.url || "/").split("?")[0];
  const filePath = path.join(__dirname, "public", path.normalize(urlPath));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    const isIndex = path.basename(filePath) === "index.html";
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable"
    };
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Book Retention Quiz running at http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("  ⚠ No ANTHROPIC_API_KEY found — copy .env.example to .env and add your key.\n");
  }
});
