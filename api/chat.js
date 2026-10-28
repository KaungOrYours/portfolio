/* =====================================================================
 * POST /api/chat — the only server-side entry point for the portfolio
 * assistant.
 *
 * Design rules:
 *   1. The browser may choose a MODE. It can never supply a system
 *      prompt. The old endpoint accepted `system` from the client,
 *      which made the Anthropic key usable as a free general-purpose
 *      Claude proxy by anyone who found the URL.
 *   2. Scope is enforced twice — a cheap deterministic pre-filter that
 *      refuses obvious abuse without spending a token, and a hard scope
 *      contract in the server-owned system prompt.
 *   3. Rate limiting lives here, not in localStorage. The client-side
 *      limiter is a UX nicety; this is the real one.
 * ===================================================================== */

const { MODES, REFUSAL, buildSystem } = require('./_kb.js');

const MODEL = 'claude-haiku-4-5-20251001';

const MAX_MESSAGES = 16;      // conversation turns kept per request
const MAX_TOTAL_CHARS = 24000; // across the whole messages array

/* ---------------------------------------------------------------------
 * Rate limiting — per IP, in-memory.
 *
 * Serverless instances are recycled, so this is best-effort rather than
 * airtight. It still removes the cheap case: one script hammering the
 * endpoint on a warm instance. Pair it with Vercel's own WAF/rate rules
 * if this ever gets real traffic.
 * ------------------------------------------------------------------- */
const RL_WINDOW_MS = 60_000;
const RL_MAX_PER_MINUTE = 12;
const RL_HOUR_MS = 3_600_000;
const RL_MAX_PER_HOUR = 80;

const hits = new Map(); // ip -> number[] (timestamps)

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function rateLimit(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RL_HOUR_MS);

  const lastMinute = recent.filter(t => now - t < RL_WINDOW_MS);
  if (lastMinute.length >= RL_MAX_PER_MINUTE) {
    hits.set(ip, recent);
    return { ok: false, retryAfter: Math.ceil((lastMinute[0] + RL_WINDOW_MS - now) / 1000) };
  }
  if (recent.length >= RL_MAX_PER_HOUR) {
    hits.set(ip, recent);
    return { ok: false, retryAfter: Math.ceil((recent[0] + RL_HOUR_MS - now) / 1000) };
  }

  recent.push(now);
  hits.set(ip, recent);

  // Keep the map from growing without bound on a long-lived instance.
  if (hits.size > 5000) {
    for (const [key, stamps] of hits) {
      if (!stamps.some(t => now - t < RL_HOUR_MS)) hits.delete(key);
    }
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------
 * Deterministic scope pre-filter.
 *
 * Deliberately narrow: it only catches messages that are unmistakably
 * "do a task for me" or "override your instructions". Anything subtler
 * is left to the model, which has the scope contract. A false positive
 * here is worse than a false negative, because the model refuses the
 * off-topic case anyway.
 * ------------------------------------------------------------------- */

// Hard-blocked regardless of whether Kaung is mentioned.
const INJECTION = [
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding)\b/i,
  /\bdisregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your)\b/i,
  /\b(system|initial|original)\s+(prompt|instructions|message)\b/i,
  /\b(your|the)\s+(instructions|rules|guidelines|prompt)\b.{0,30}\b(what|repeat|show|print|reveal|tell|ignore|forget)\b/i,
  /\b(repeat|print|output|reveal|show|echo|list|dump|tell me)\b.{0,20}\b(your|the)\s+(instructions|rules|prompt|guidelines|system message|knowledge base)\b/i,
  /\b(pretend|imagine|suppose|assume)\s+(that\s+)?you(?:'re| are|r)\b/i,
  /\b(repeat|print|output|reveal|show|echo)\b.{0,40}\b(above|verbatim|word for word|knowledge base|prompt)\b/i,
  /\byou are (now|no longer)\b/i,
  /\b(act|behave|pretend|roleplay|role-play)\s+(as|like)\b.{0,30}\b(if you|a |an |you are)/i,
  /\b(jailbreak|DAN mode|developer mode|god mode|unrestricted mode)\b/i,
  /\bforget\s+(everything|all|your)\b/i,
  /\bnew\s+(instructions|system\s+prompt|rules)\s*[:\-]/i,
];

// Blocked only when the message makes no reference to Kaung or his work.
const TASK_REQUEST = [
  /\b(what(?:'s| is| are)?|how)\b.{0,25}\b(the\s+)?(python|java|javascript|c\+\+|c#|sql|rust|go|php|ruby|bash|html|css|react)\b.{0,25}\b(code|script|syntax|function|snippet|command|query)\b/i,
  /\b(write|generate|create|produce|build|implement|give me|show me|send me|make me|fix|debug|refactor|optimi[sz]e|translate|rewrite|summari[sz]e|explain)\b.{0,40}\b(code|program|script|function|class|method|snippet|regex|query|algorithm|app|website|component|essay|poem|story|email|letter|recipe|joke|song|article|blog post|cover letter|homework|assignment)\b/i,
  /\bhow (do|can|would) (i|you|we)\b.{0,40}\b(in|using|with)\s+(python|java|javascript|typescript|sql|c\+\+|c#|rust|go|php|ruby|bash|react|node|css|html|excel|pandas|numpy)\b/i,
  /\b(solve|calculate|compute|evaluate|integrate|differentiate)\b.{0,30}\b(this|the|following|equation|integral|derivative|problem|sum)\b/i,
  /\bwhat is the (capital|population|weather|time|date|price|meaning of life)\b/i,
  /\bwho (is|was) the (president|prime minister|ceo|king|queen)\b/i,
  /\btranslate\b.{0,30}\b(to|into)\s+\w+/i,
];

// Anything in here means the message is plausibly about Kaung or his work.
const IN_SCOPE_REF = /\b(kaung|benjamin|he|his|him|himself|candidate|this person|portfolio|cv|r[eé]sum[eé]|ka-?nova|gabm|mfu|ieee|rasse|jasss|tiancheng|psb|hertfordshire|coventry|khine|pdf2epub|epub|recommender|sme analytics|conflict risk|dissertation|thesis|publication|supervisor|mesa|cves|monte carlo|passport|mmr.?passport|myanmar embassy|telegram bot|webauthn|passkey)\b/i;

function preFilterRefuses(text) {
  if (INJECTION.some(re => re.test(text))) return true;
  if (TASK_REQUEST.some(re => re.test(text)) && !IN_SCOPE_REF.test(text)) return true;
  return false;
}

/* ---------------------------------------------------------------------
 * Request validation
 * ------------------------------------------------------------------- */
function validate(body) {
  const mode = typeof body.mode === 'string' ? body.mode : 'ask';
  if (!MODES[mode]) return { error: 'Unknown mode' };

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Request must include a non-empty "messages" array' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: 'Conversation too long — start a new one' };
  }

  const cfg = MODES[mode];
  const clean = [];
  let total = 0;

  for (const m of messages) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = m && typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) return { error: 'Every message needs non-empty text content' };
    if (content.length > cfg.maxChars) {
      return { error: `Message too long (max ${cfg.maxChars} characters)` };
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) return { error: 'Conversation too long — start a new one' };
    clean.push({ role, content });
  }

  if (clean[clean.length - 1].role !== 'user') {
    return { error: 'The last message must be from the user' };
  }

  return { mode, messages: clean };
}

/* ---------------------------------------------------------------------
 * Handler
 * ------------------------------------------------------------------- */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
    return;
  }

  const limited = rateLimit(clientIp(req));
  if (!limited.ok) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    res.status(429).json({
      error: 'Too many requests — please wait a moment.',
      retryAfter: limited.retryAfter,
    });
    return;
  }

  const parsed = validate(req.body || {});
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const { mode, messages } = parsed;
  const latest = messages[messages.length - 1].content;

  // Cheap refusal — never reaches Claude. Returned as a normal assistant
  // turn (200) so the chat UI renders it like any other reply.
  if (mode !== 'matcher' && preFilterRefuses(latest)) {
    res.status(200).json({ text: REFUSAL, refused: true });
    return;
  }

  const cfg = MODES[mode];

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: cfg.maxTokens,
        // The system prompt is byte-identical on every request for a given
        // mode, so it caches cleanly. Only the messages vary, and they sit
        // after the breakpoint.
        system: [
          {
            type: 'text',
            text: buildSystem(mode),
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      }),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const message = data?.error?.message || 'Upstream request failed';
      // Never leak upstream detail that might include key or account info.
      const safe = upstream.status === 429
        ? 'The assistant is busy right now — try again shortly.'
        : message;
      res.status(upstream.status).json({ error: safe });
      return;
    }

    // Safety classifiers can decline with a 200 and an empty content array.
    if (data?.stop_reason === 'refusal') {
      res.status(200).json({ text: REFUSAL, refused: true });
      return;
    }

    const text = Array.isArray(data?.content)
      ? data.content.filter(b => b?.type === 'text').map(b => b.text).join('').trim()
      : '';

    if (!text) {
      res.status(502).json({ error: 'Empty response from Claude' });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Claude API' });
  }
};

// Exposed for local testing of the scope pre-filter (see scripts/test-guard.js).
module.exports._test = { preFilterRefuses, validate };
