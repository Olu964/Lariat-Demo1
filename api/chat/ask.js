'use strict';

/*
 * Vercel serverless function: Kevin chat (pure-LLM design).
 *
 *   POST /api/chat/ask   { question, history? }
 *
 * Every request sends the full bill snapshot plus the full Lariat site
 * knowledge to the model. The model itself decides whether the user asks
 * about the site or about bills, picks relevant bills, resolves follow-ups
 * from conversation history, and justifies connections. There is no keyword
 * routing, no synonym tables, and no intent regexes in this path.
 * OpenStates supplements the snapshot when the question names a bill the
 * feed does not contain. Keys stay server-side — the browser sees only
 * answer + citations.
 */

const OPEN_STATES_BILL_URL = 'https://v3.openstates.org/bills';
const UPSTREAM_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 40;

const rateHits = new Map();
let billsCache = null;

function rateLimited(ip) {
  const now = Date.now();
  const entry = rateHits.get(ip);
  if (!entry || now - entry.startedAt > RATE_WINDOW_MS) {
    if (rateHits.size > 5000) rateHits.clear();
    rateHits.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const sendErr = (res, status, message, code) => sendJson(res, status, { ok: false, error: String(message), code });

function sanitizedQuestion(value) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function safeUrl(v) {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return '';
  try { return new URL(v).href; } catch (e) { return ''; }
}

function loadBills() {
  if (billsCache) return billsCache;
  try {
    const parsed = require('../../texas_bill_summaries.json');
    billsCache = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bills) ? parsed.bills : [];
  } catch (e) { billsCache = []; }
  return billsCache;
}

let siteKbCache = null;

function loadSiteKb() {
  if (siteKbCache) return siteKbCache;
  try {
    const parsed = require('../../site_knowledge.json');
    siteKbCache = parsed && Array.isArray(parsed.topics) ? parsed : { topics: [] };
  } catch (e) { siteKbCache = { topics: [] }; }
  return siteKbCache;
}

// Compact feed lines (~40 bills, ~2.5k tokens). Built live from the snapshot,
// so bills added by the GitHub workflow are automatically in context.
function feedContext(bills) {
  const firstWords = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
  return (bills || []).map((b) => {
    const affects = String(b.affects || b.specific_industry || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'n/a';
    return `- ${b.identifier}: ${b.title}. Affects: ${affects}. ${firstWords(b.summary || b.changes, 30)}`;
  }).join('\n');
}

// Whole site knowledge, compacted (keywords stripped — the model matches by meaning).
function siteContext(kb) {
  const site = (kb && kb.site) || {};
  const pages = site.pages ? `Pages: home, feed, legislator, calendar, pricing, privacy, accessibility.` : '';
  const topics = ((kb && kb.topics) || []).map((t) => `- [${t.id}] ${t.answer}`).join('\n');
  return `${site.tagline || ''} Status: ${site.status || ''} Feedback email: ${site.feedback_email || ''}\n${pages}\n${topics}`;
}

const normId = (letters, num) => `${String(letters || '').toUpperCase()} ${parseInt(String(num || ''), 10)}`;

// Citations follow the answer: whatever bills Kevin actually discussed become
// the linked sources.
function citationsFromAnswer(answer, raws, clean) {
  const byId = new Map();
  for (const b of (raws || [])) {
    const m = /^\s*([A-Za-z]+)\s*0*(\d+)\s*$/.exec(String(b.identifier || ''));
    if (m) byId.set(normId(m[1], m[2]), b);
  }
  const seen = new Set();
  const out = [];
  const re = /\b((?:HJR|HCR|SB|HB|SR|HR|SJR))\s*-?\s*(\d{1,4})\b/gi;
  let m;
  while ((m = re.exec(String(answer || ''))) && out.length < 3) {
    const key = normId(m[1], m[2]);
    if (seen.has(key) || !byId.has(key)) continue;
    seen.add(key);
    out.push(byId.get(key));
  }
  return out.map((b) => clean(b)).filter((c) => c.identifier);
}

async function fetchOpenStates(question, apiKey) {
  if (!apiKey) return [];
  try {
    const url = new URL(OPEN_STATES_BILL_URL);
    url.searchParams.set('jurisdiction', 'Texas');
    url.searchParams.set('q', question.slice(0, 120));
    url.searchParams.set('per_page', '3');
    const r = await fetch(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!r.ok) return [];
    const body = await r.json().catch(() => null);
    const arr = Array.isArray(body?.results) ? body.results : [];
    return arr.slice(0, 3).map((b) => ({
      identifier: b.identifier || 'TX bill', title: b.title || '',
      summary: Array.isArray(b.abstracts) && b.abstracts[0]?.abstract ? b.abstracts[0].abstract : '',
      status: b.latest_action_description || '', industry: '',
      sourceUrl: safeUrl((b.sources && b.sources[0]?.url) || b.openstates_url),
    }));
  } catch (e) { return []; }
}

function sanitizeAiText(text) {
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/<\|[^|]*\|>/g, ' ');
  cleaned = cleaned.replace(/\b[a-zA-Z_]+\(\s*query\s*=\s*('[^']*'|"[^"]*")\s*\)/g, ' ');
  cleaned = cleaned.replace(/\[\s*(,\s*)*\]/g, ' '); // empty brackets left behind
  cleaned = cleaned.replace(/^\s*based on\b[^.!?\n]{0,140}?:\s*/i, '');
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function looksTruncated(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return !/[.!?]['"”’)\]]?\s*$/.test(trimmed);
}

// Safety net: peel any trailing disclaimer the model emits anyway ("Not
// legal advice", optionally paired with "verify with official sources").
// The notice lives under the chat window, so answers stay clean.
function stripDisclaimer(text) {
  let out = String(text || '').trim();
  for (let i = 0; i < 2; i += 1) {
    out = out
      .replace(/\s*not legal advice\s*[.;]?\s*(verify with official sources\s*[.;]?)?\s*$/i, '')
      .replace(/\s*verify with official sources\s*[.;]?\s*$/i, '')
      .trim();
  }
  return out;
}

// Safety net: free-tier models sometimes emit section headers anyway; strip
// them and keep the content as plain prose paragraphs.
function enforceProse(text) {
  const out = String(text || '').replace(/^\s*(Who|What|How|Why|Bottom line)\s*:\s*/gim, '');
  return out.replace(/(^|\n\n)\s*([a-z])/g, (m, p, c) => `${p}${c.toUpperCase()}`).trim();
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { throw { status: 400, code: 'bad_request' }; } }
    throw { status: 400, code: 'bad_request' };
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 100_000) throw { status: 413, code: 'body_too_large' }; chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function ip(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendErr(res, 405, 'Method not allowed', 'method');
  if (!/^application\/json/.test(String(req.headers['content-type'] || '').toLowerCase())) {
    return sendErr(res, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
  }
  if (rateLimited(ip(req))) return sendErr(res, 429, 'Too many questions. Please wait and try again.', 'rate_limited');
  let body;
  try { body = await readBody(req); } catch (e) { return sendErr(res, Number(e.status) || 400, 'Invalid request.', e.code || 'bad_request'); }
  const question = sanitizedQuestion(body.question);
  if (!question || question.length < 3) return sendErr(res, 400, 'Please ask a question about Texas bills or this site.', 'invalid_question');

  const cleanField = (v, n = 300) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const toCite = (b) => ({
    identifier: String(b.identifier || ''),
    title: String(b.title || 'Untitled bill'),
    summary: String(b.summary || b.changes || '').slice(0, 600),
    status: String(b.status || b.latest_action_description || ''),
    industry: String(b.industry || ''),
    affects: cleanField(b.affects),
    changes: cleanField(b.changes),
    businessImpact: cleanField(b.business_impact),
    sourceUrl: safeUrl(b.sourceUrl || b.source_url),
  });
  const allBills = loadBills();
  const kb = loadSiteKb();
  const history = Array.isArray(body.history) ? body.history.slice(-2).map((h) => ({
    q: String(h.q || h.question || '').slice(0, 200),
    a: String(h.a || h.answer || '').slice(0, 300),
  })).filter((h) => h.q) : [];
  const histLine = history.length
    ? `Conversation so far: ${history.map((h) => `User: ${h.q} || Kevin: ${h.a}`).join(' ||| ').slice(0, 900)}\n`
    : '';

  // OpenStates supplements the feed only when the question names a bill the
  // snapshot does not contain (otherwise the feed already covers it).
  const osKey = process.env.OPEN_STATES_API_KEY || '';
  let osResults = [];
  const namedInFeed = (() => {
    const ids = new Set(allBills.map((b) => String(b.identifier || '').replace(/\s+/g, '').toLowerCase()));
    const re = /\b([hs][bjr]{0,2})\s*-?\s*(\d{1,4})\b/gi;
    let m;
    while ((m = re.exec(question))) {
      if (!ids.has(`${m[1]}${m[2]}`.replace(/\s+/g, '').toLowerCase())) return false;
    }
    return true;
  })();
  if (osKey && !namedInFeed) osResults = await fetchOpenStates(question, osKey);
  const osCtx = osResults.length
    ? `\n\nOPEN STATES RECORDS (outside the Lariat feed):\n${osResults.map((c) => `- ${c.identifier}: ${c.title}. ${String(c.summary).slice(0, 300)}`).join('\n')}`
    : '';
  const bigCtx = `LARIAT SITE INFO:\n${siteContext(kb)}\n\nTEXAS BILL FEED (${allBills.length} bills, plain-English summaries of official text):\n${feedContext(allBills)}${osCtx}`;

  const joinContinuation = (draft, chunk) => {
    const left = String(draft || '').trimEnd();
    const right = String(chunk || '').trimStart();
    if (!left) return right;
    if (!right) return left;
    return `${left}${(/[A-Za-z0-9]$/.test(left) && /^[a-z0-9]/.test(right)) ? '' : ' '}${right}`;
  };
  const orKey = process.env.OPENROUTER_API_KEY || '';
  const orChat = async (model, messages) => {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model, max_tokens: 8192, temperature: 0.3, // max all rotation models accept; $0 on :free
        messages,
      }),
    });
    if (!r.ok) {
      const err = new Error(`OpenRouter HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json().catch(() => null);
    const raw = typeof j?.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content : '';
    return sanitizeAiText(raw);
  };
  const KEVIN_SYS = 'You are Kevin, a conversational Texas Legislature helper on the Lariat site — never claim any other name or model identity. Talk like a helpful person, not a form. Below you have Lariat site info, the full Texas bill feed, and possibly OpenStates records (marked, outside the feed). Decide yourself whether the user asks about the site or about bills. Pick relevant bills yourself, compare when useful, and explain in everyday words how a bill connects to the asker (use would/could for inference). If asked for an opinion or what is most important, give a direct judgment call and justify it. If the question is ambiguous, ask ONE clarifying question instead of guessing. Use the conversation history for follow-ups ("it", "that one", "what about renters?"). Answer THIS question fresh; never repeat a previous answer unless the user asked for the same thing. Ground everything in the sources; name the bill identifiers you discuss. If nothing fits, say so starting with the words "No bill in the current bill feed" and suggest how to browse. Never use Who:, How:, Why:, What:, or Bottom line: labels. Copy the Affects field exactly when stating who a bill affects; never invent affected groups. Max 150 words (a clarifying question may be shorter). Do not add any disclaimer, sign-off, or Not legal advice line — the site already shows that notice under the chat.';
  const CONTINUE = 'Continue exactly where you left off. Do not repeat anything already written, do not restart, no preamble.';

  let answer = '';
  let aiEnhanced = false;
  const firstUser = `${histLine}User asks: ${question}\n\n${bigCtx}`;
  // Rotation of free models proven (Oct 2026) to answer with the full
  // feed + site context at max_tokens 8192. qwen3.8-27b:free was retired
  // from free (404) and gemma-4:free is chronically 429 upstream, so both
  // are out. Fail over to the next model immediately on any error — with
  // several healthy lanes, failover beats retrying a congested one.
  const orModels = [process.env.SUMMARIZER_MODEL || '', 'nvidia/nemotron-3-super-120b-a12b:free', 'dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'liquid/lfm-2.5-2.6b:free'].filter(Boolean);
  let partial = '';
  let carry = ''; // truncated thread passed model-to-model until finished
  for (const model of orModels) {
    if (aiEnhanced || !orKey) break;
    let draft = carry;
    for (let round = 0; round < 3; round += 1) {
      const fresh = !draft;
      const messages = fresh
        ? [{ role: 'system', content: KEVIN_SYS }, { role: 'user', content: firstUser }]
        : [
          { role: 'system', content: KEVIN_SYS },
          { role: 'user', content: firstUser },
          { role: 'assistant', content: draft },
          { role: 'user', content: CONTINUE },
        ];
      let chunk = '';
      try {
        chunk = await orChat(model, messages);
      } catch (e) {
        break; // model failed: fail over to the next model immediately
      }
      if (!chunk) break; // model failed: next model
      draft = fresh ? chunk : joinContinuation(draft, chunk);
      if (!looksTruncated(chunk) || draft.length > 2400) {
        if (!looksTruncated(draft)) { answer = draft.slice(0, 2400); aiEnhanced = true; }
        break;
      }
    }
    carry = draft && looksTruncated(draft) ? draft : '';
    if (draft && !partial) partial = draft;
  }
  if (!aiEnhanced && partial) { answer = partial.slice(0, 2400); aiEnhanced = true; }
  const gemKey = process.env.GEMINI_API_KEY || '';
  if (!aiEnhanced && gemKey) {
    try {
      for (const model of [process.env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(gemKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: KEVIN_SYS + ' No preamble, never output tool calls, search queries, <|...|> tokens, or thinking — only the final answer. Plain text only, no markdown symbols or numbered lists. Short paragraphs separated by blank lines.' }] },
            contents: [{ parts: [{ text: firstUser }] }],
            generationConfig: { maxOutputTokens: 700, temperature: 0.3 },
          }),
        });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        const parts = j?.candidates?.[0]?.content?.parts;
        const raw = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
        const t = sanitizeAiText(raw);
        if (t) { answer = t.slice(0, 1200); aiEnhanced = true; break; }
      }
    } catch (e) { /* fall through to busy message */ }
  }

  if (!aiEnhanced) {
    return sendJson(res, 200, {
      ok: true,
      answer: 'My answer engine is unreachable right now, so I cannot reason over the feed. Please browse the bill feed directly or try again in a bit.',
      citations: [],
      topic: 'busy',
      aiEnhanced: false,
      openStatesUsed: Boolean(osKey),
    });
  }
  const cited = citationsFromAnswer(answer, [...allBills, ...osResults], toCite);
  return sendJson(res, 200, {
    ok: true,
    answer: enforceProse(stripDisclaimer(answer)),
    citations: cited.slice(0, 3),
    topic: 'chat',
    aiEnhanced,
    openStatesUsed: Boolean(osKey),
  });
};
