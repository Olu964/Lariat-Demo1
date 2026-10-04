'use strict';

/*
 * Vercel serverless function: chatbot Q&A for Texas bills.
 *
 *   POST /api/chat/ask   { question }
 *
 * Stateless port of handleChatAsk in server/server.js (local dev).
 * Local snapshot is bundled via require() so @vercel/nft includes it.
 * OpenStates + OpenRouter keys come from Vercel env vars and are never
 * returned to the browser — the frontend sees only answer + citations.
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

function searchLocal(question, bills) {
  // Shared logic with server/server.js searchLocalBills — keep in sync.
  const q = question.toLowerCase();
  const m = q.match(/\b([hs][bjr]{0,2})\s*-?\s*(\d{1,4})\b/i);
  if (m) {
    const compact = `${m[1]}${m[2]}`.replace(/\s+/g, '').toLowerCase();
    const hits = bills.filter((b) => String(b.identifier || '').replace(/\s+/g, '').toLowerCase() === compact);
    if (hits.length) return hits.slice(0, 3);
  }
  // Generic request/audience verbs are NOT substantive — scoring them is what
  // used to surface random bills (e.g. "one"/"that"/"affect" matching SB 58
  // for a high-schooler question). Whole-word matching + field weights fix it.
  const stop = new Set(['what', 'does', 'the', 'and', 'for', 'texas', 'law', 'laws', 'bill', 'bills', 'about', 'give', 'get', 'got', 'show', 'find', 'lists', 'list', 'tell', 'name', 'one', 'two', 'single', 'that', 'this', 'these', 'those', 'they', 'them', 'their', 'there', 'here', 'might', 'could', 'would', 'should', 'will', 'shall', 'may', 'can', 'must', 'affect', 'affects', 'affected', 'affecting', 'effect', 'effects', 'impact', 'impacts', 'why', 'how', 'who', 'whom', 'whose', 'which', 'when', 'where', 'whether', 'with', 'from', 'into', 'doing', 'done', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'please', 'like', 'just', 'really', 'very', 'much', 'many', 'some', 'any', 'each', 'every', 'all', 'both', 'few', 'more', 'most', 'other', 'same', 'only', 'own', 'such', 'than', 'then', 'also', 'me', 'you', 'your', 'our', 'hello', 'hi', 'hey', 'thanks', 'thank', 'okay']);
  const baseWords = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w));
  // Audience synonym expansion: "highschoolers" never appears verbatim in
  // bill text, but "student/youth/teen/school/education" does.
  const extra = new Set();
  if (/high\s*school|highschool|student|teen|youth|kid\b|kids|child|school|education|college|campus|minor\b|minors|juvenile|pupil/.test(q)) {
    ['student', 'students', 'youth', 'teen', 'teens', 'school', 'schools', 'education', 'camp', 'camps', 'child', 'children', 'minor'].forEach((w) => extra.add(w));
  }
  const words = [...new Set([...baseWords, ...extra])];
  if (!words.length) return [];
  const fieldTokens = (v) => new Set(String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const hasWord = (set, w) => set.has(w) || (w.endsWith('s') && set.has(w.slice(0, -1))) || set.has(`${w}s`);
  return bills.map((b) => {
    const t = fieldTokens(b.title);
    const a = fieldTokens(`${b.affects || ''} ${b.specific_industry || ''}`);
    const c = fieldTokens(b.changes);
    const s = fieldTokens(`${b.summary || ''} ${b.business_impact || ''}`);
    const ind = fieldTokens(b.industry);
    let score = 0;
    for (const w of words) {
      if (hasWord(t, w)) score += 4;
      if (hasWord(a, w)) score += 4;
      if (hasWord(c, w)) score += 2;
      if (hasWord(s, w)) score += 1;
      if (hasWord(ind, w)) score += 1;
    }
    return { b, s: score };
  }).filter((x) => x.s >= 4).sort((a, b2) => b2.s - a.s).slice(0, 3).map((x) => x.b);
}

// Follow-up like "why does this bill impact high schoolers" has no bill
// number. If the frontend sends the bills from the previous turn
// (contextIds), reuse them instead of keyword-guessing a new bill.
function resolveFollowUp(question, bills, contextIds) {
  if (!Array.isArray(contextIds) || !contextIds.length) return [];
  if (/\b([hs][bjr]{0,2})\s*-?\s*(\d{1,4})\b/i.test(question)) return [];
  if (!/\b(this|that|it|these|those|same|the bill|this bill|that bill)\b/i.test(question)) return [];
  const wanted = new Set(contextIds.map((v) => String(v || '').replace(/\s+/g, '').toLowerCase()));
  const hits = bills.filter((b) => wanted.has(String(b.identifier || '').replace(/\s+/g, '').toLowerCase()));
  return hits.slice(0, 3);
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

// Safety net: free-tier models often ignore the no-labels instruction, so
// strip any Who:/How:/Why:/What: section headers the AI emits and keep the
// content as plain prose paragraphs.
function enforceProse(text) {
  const out = String(text || '').replace(/^\s*(Who|What|How|Why|Bottom line)\s*:\s*/gim, '');
  return out.replace(/(^|\n\n)\s*([a-z])/g, (m, p, c) => `${p}${c.toUpperCase()}`).trim();
}

function extractive(question, citations) {
  if (!citations.length) return 'I could not find a matching Texas bill in the current snapshot. Try a bill number (e.g. “What does SB 1 do?”) or browse the bill feed. Not legal advice — verify with official sources.';
  const top = citations[0];
  const cut = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n)).trimEnd());
  const q = String(question || '').toLowerCase();
  // Safety net: audience query (e.g. high-schoolers) matched a bill with no
  // audience link — be honest instead of presenting it as a direct answer.
  const asksStudents = /high\s*school|highschool|student|teen|school|youth|child|kid|education/.test(q);
  const blob = `${top.title || ''} ${top.summary || ''} ${top.affects || ''} ${top.changes || ''}`.toLowerCase();
  const hasStudentLink = /student|youth|teen|school|education|child|camp|minor|juvenile|pupil/.test(blob);
  const honestyPrefix = (asksStudents && !hasStudentLink)
    ? 'No bill in the current snapshot directly targets high schoolers. Closest match, with a weak link: '
    : '';
  // Prose-only fallback: content adapts to the question (audience, mechanism,
  // reason) but never uses Who:/How:/Why: labels.
  const wantsAudience = /\bwho\b|\bwhom\b|\baffect(s|ed|ing)?\b|\bimpact(s|ed|ing)?\b|\bhigh\s*school|highschool|student|teen|school|youth|child|kid|education/.test(q);
  const wantsMechanism = /\bhow\b/.test(q);
  const withPeriod = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
    return t ? `${t}.` : '';
  };
  const parts = [`${honestyPrefix}${top.identifier} — ${top.title}.`];
  if (wantsAudience && top.affects) parts.push(`It affects ${top.affects}.`);
  if (wantsMechanism && top.changes) parts.push(withPeriod(top.changes));
  if (top.summary) parts.push(top.summary.slice(0, 450));
  if (top.status) parts.push(`Status: ${top.status}.`);
  const extra = citations.length > 1 ? ` Related: ${citations.slice(1).map((c) => c.identifier).join(', ')}.` : '';
  return enforceProse(`${cut(parts.join(' '), 1000)}${extra} See the linked source. Not legal advice.`);
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
  if (!question || question.length < 3) return sendErr(res, 400, 'Please ask a question about a Texas bill.', 'invalid_question');

  const cleanField = (v, n = 300) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const allBills = loadBills();
  const followed = resolveFollowUp(question, allBills, body.contextIds);
  let citations = (followed.length ? followed : searchLocal(question, allBills)).map((b) => ({
    identifier: String(b.identifier || ''), title: String(b.title || 'Untitled bill'),
    summary: String(b.summary || b.changes || ''), status: String(b.status || ''),
    industry: String(b.industry || ''), sourceUrl: safeUrl(b.source_url),
    affects: cleanField(b.affects), changes: cleanField(b.changes),
    businessImpact: cleanField(b.business_impact),
  })).filter((c) => c.identifier);

  if (!citations.length) citations = await fetchOpenStates(question, process.env.OPEN_STATES_API_KEY || '');

  const joinContinuation = (draft, chunk) => {
    const left = String(draft || '').trimEnd();
    const right = String(chunk || '').trimStart();
    if (!left) return right;
    if (!right) return left;
    return `${left}${(/[A-Za-z0-9]$/.test(left) && /^[a-z0-9]/.test(right)) ? '' : ' '}${right}`;
  };
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
  const KEVIN_SYS = 'You are Kevin, the Texas Legislature helper — never claim any other name or model identity. Use only provided context. Cite identifiers. If the context has no bill clearly related to the question (e.g. a high-schooler question with only a groundwater bill), say so honestly and label the closest as closest with a weak link — never present an unrelated bill as a direct answer. Always answer in plain sentences shaped by the question. Never use Who:, How:, Why:, What:, or Bottom line: labels or section headers. Copy Affects exactly; never invent groups or import audiences from history. Max 150 words. End: Not legal advice.';
  const CONTINUE = 'Continue exactly where you left off. Do not repeat anything already written, do not restart, no preamble.';

  // Optional AI rewrite when configured (OpenRouter preferred, Gemini fallback).
  let answer = extractive(question, citations);
  let aiEnhanced = false;
  const ctx = citations.map((c) => `- ${c.identifier}: ${c.title}. Affects: ${c.affects || 'n/a'}. Changes: ${c.changes || String(c.summary || '').slice(0, 200)}. ${String(c.summary).slice(0, 300)}`).join('\n');
  // Only include conversation history for true follow-ups ("this bill"...).
  // Otherwise prior turns leak style/audiences (e.g. "high school students")
  // into unrelated answers.
  const isFollowUp = followed.length > 0;
  const histLine = isFollowUp && Array.isArray(body.history) && body.history.length
    ? `Previous: ${body.history.slice(-2).map((h) => `Q: ${String(h.q || '').slice(0, 200)} A: ${String(h.a || '').slice(0, 300)}`).join(' | ').slice(0, 600)}\n`
    : (followed.length ? `Note: "this bill" refers to ${followed.map((b) => b.identifier).join(', ')}. Answer about those bills.\n` : '');
  const orKey = process.env.OPENROUTER_API_KEY || '';
  const firstUser = `${histLine}Q: ${question}\n${ctx}`;
  const orModels = [process.env.SUMMARIZER_MODEL || '', 'google/gemma-4-26b-a4b-it:free', 'qwen/qwen3.8-27b:free', 'liquid/lfm-2.5-2.6b:free'].filter(Boolean);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let partial = '';
  let carry = ''; // truncated thread passed model-to-model until finished
  for (const model of orModels) {
    if (aiEnhanced || !orKey || !citations.length) break;
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
      for (let attempt = 0; attempt < 2 && !chunk; attempt += 1) {
        try {
          chunk = await orChat(model, messages);
        } catch (e) {
          if (e && e.status === 429 && attempt === 0) { await sleep(2500); continue; }
          break;
        }
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
  if (!aiEnhanced && gemKey && citations.length) {
    try {
      for (const model of [process.env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(gemKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: 'Your name is Kevin. You are Kevin, the Texas Legislature helper — never claim any other name or model identity. Use only provided context. Cite identifiers. If the context has no bill clearly related to the question, say so honestly and label the closest as closest with a weak link — never present an unrelated bill as a direct answer. Always answer in plain sentences shaped by the question. Never use Who:, How:, Why:, What:, or Bottom line: labels or section headers. Copy Affects exactly; never invent groups or import audiences from history. No preamble, never output tool calls, search queries, <|...|> tokens, or thinking — only the final answer. Plain text only, no markdown symbols or numbered lists. Short paragraphs separated by blank lines. Max 150 words. End: Not legal advice.' }] },
            contents: [{ parts: [{ text: `${histLine}Q: ${question}\n${ctx}` }] }],
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
    } catch (e) { /* keep extractive */ }
  }

  return sendJson(res, 200, { ok: true, answer: enforceProse(answer), citations: citations.slice(0, 3), aiEnhanced, openStatesUsed: Boolean(process.env.OPEN_STATES_API_KEY) });
};
