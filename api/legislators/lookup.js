'use strict';

/*
 * Vercel serverless function: legislator lookup for the static frontend.
 *
 *   POST /api/legislators/lookup   { address }
 *
 * This is a stateless port of the same lookup in server/server.js (used for
 * local development). Vercel's static hosting cannot run that long-lived Node
 * server, so without this file the live site POSTs to a same-origin endpoint
 * that does not exist and every lookup fails.
 *
 * Flow (identical to local): Census geocode (full address or ZIP centroid) →
 * verify the point is in Texas → Open States people.geo → normalize to one
 * Senate + one House record → attach recent major-bill voting history.
 *
 * Serverless adaptations:
 *   - No filesystem: the 24h lookup cache and rate limits live in module-scope
 *     memory (per function instance, best effort) instead of JSON files.
 *   - The bill snapshot is bundled via require() so @vercel/nft includes it.
 *   - Secrets come from Vercel project environment variables (dashboard →
 *     Settings → Environment Variables): OPEN_STATES_API_KEY is required.
 *   - Every error body uses a string `error` field, never an object shape.
 */

const CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_ZCTA_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/11/query';
const CENSUS_GEOGRAPHIES_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const OPEN_STATES_GEO_URL = 'https://v3.openstates.org/people.geo';
const OPEN_STATES_BILL_URL = 'https://v3.openstates.org/bills';

const MAX_ADDRESS_LENGTH = 240;
const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;
const TEXAS_STATE_BOUNDS = { minLat: 25.8, maxLat: 36.6, minLng: -106.7, maxLng: -93.4 };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Best-effort per-instance state (a fresh instance starts empty; correctness
// never depends on a cache hit).
const cache = new Map(); // key -> { cachedAt, legislators }
const inFlight = new Map(); // key -> Promise
const rateHits = new Map(); // ip -> { startedAt, count }
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 30;

function lookupError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sanitizedLookupInput(value) {
  return String(value || '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cacheKeyForAddress(address) {
  return sanitizedLookupInput(address).toLowerCase();
}

function isZipAddress(address) {
  return ZIP_PATTERN.test(address);
}

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

function cachedLegislatorsAreUsable(legislators) {
  return Array.isArray(legislators)
    && legislators.length === 2
    && ['Senate', 'House'].every((chamber) => legislators.some((person) => person?.chamber === chamber))
    && legislators.every((person) => person && typeof person.name === 'string'
      && person.chamber && typeof person.district === 'string'
      && person.district !== 'Texas'
      && typeof person.votingHistoryStatus === 'string'
      && Array.isArray(person.votingHistory));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw lookupError(502, 'upstream_error', `Lookup service returned HTTP ${response.status}`);
  if (!body || typeof body !== 'object') throw lookupError(502, 'upstream_error', 'Lookup service returned an invalid response');
  return body;
}

async function geocodeFullAddress(address) {
  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set('address', address);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  const body = await fetchJson(url);
  const match = body.result?.addressMatches?.[0];
  const longitude = Number(match?.coordinates?.x);
  const latitude = Number(match?.coordinates?.y);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw lookupError(404, 'not_geocoded', 'We could not geocode that address.');
  }
  return { latitude, longitude };
}

async function geocodeZip(zip) {
  const url = new URL(CENSUS_ZCTA_URL);
  url.searchParams.set('where', `ZCTA5='${zip.slice(0, 5)}'`);
  url.searchParams.set('outFields', 'CENTLAT,CENTLON');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  const body = await fetchJson(url);
  const attributes = body.features?.[0]?.attributes;
  const latitude = Number(attributes?.CENTLAT);
  const longitude = Number(attributes?.CENTLON);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw lookupError(404, 'not_geocoded', 'We could not geocode that ZIP code.');
  }
  return { latitude, longitude };
}

async function isTexasCoordinate(latitude, longitude) {
  if (latitude < TEXAS_STATE_BOUNDS.minLat || latitude > TEXAS_STATE_BOUNDS.maxLat
    || longitude < TEXAS_STATE_BOUNDS.minLng || longitude > TEXAS_STATE_BOUNDS.maxLng) return false;
  const url = new URL(CENSUS_GEOGRAPHIES_URL);
  url.searchParams.set('x', String(longitude));
  url.searchParams.set('y', String(latitude));
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('layers', 'States');
  url.searchParams.set('format', 'json');
  const body = await fetchJson(url);
  return body.result?.geographies?.States?.some((state) => state.STUSAB === 'TX' || state.NAME === 'Texas') === true;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (error) { return ''; }
}

function normalizeLegislator(person) {
  const role = person && typeof person.current_role === 'object' ? person.current_role : {};
  const orgClassification = firstString(role.org_classification, role.classification).toLowerCase();
  const title = firstString(role.title).toLowerCase();
  const chamber = orgClassification === 'upper' || title.includes('senat') ? 'Senate'
    : orgClassification === 'lower' || title.includes('represent') ? 'House' : '';
  if (!chamber) return null;

  // people.geo can include federal officeholders at a coordinate. Require an
  // explicit Texas state-legislature jurisdiction or state legislative-district
  // division so a U.S. senator cannot be presented as a Texas state senator.
  const jurisdiction = person.jurisdiction;
  const jurisdictionId = firstString(
    typeof jurisdiction === 'string' ? jurisdiction : jurisdiction?.id,
    typeof jurisdiction === 'object' ? jurisdiction?.name : '',
  ).toLowerCase();
  const divisionId = firstString(role.division_id, person.division_id).toLowerCase();
  const isTexasStateJurisdiction = jurisdictionId.includes('texas')
    || jurisdictionId.includes('state:tx');
  const isStateLegislativeDivision = divisionId.includes('/sldl:') || divisionId.includes('/sldu:');
  if (!isTexasStateJurisdiction && !isStateLegislativeDivision) return null;

  return {
    personId: firstString(person.id),
    name: firstString(person.name) || 'Name unavailable',
    chamber,
    party: firstString(person.party) || 'Party not listed',
    district: role.district === null || role.district === undefined ? '' : String(role.district),
    photoUrl: safeHttpUrl(person.image) || null,
  };
}

let billsCache = null;
function majorBillsForVoteHistory() {
  if (billsCache) return billsCache;
  let bills = [];
  try {
    // Static require so @vercel/nft bundles the snapshot into the function.
    const parsed = require('../../texas_bill_summaries.json');
    bills = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bills) ? parsed.bills : [];
  } catch (error) { bills = []; }
  billsCache = bills
    .filter((bill) => bill && typeof bill.id === 'string' && typeof bill.identifier === 'string'
      && ['moderate', 'high'].includes(String(bill.impact_level || '').toLowerCase()))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 5)
    .map((bill) => ({
      id: bill.id,
      identifier: bill.identifier,
      session: typeof bill.session === 'string' || typeof bill.session === 'number' ? String(bill.session) : '',
      title: firstString(bill.title) || 'Untitled bill',
      updatedAt: firstString(bill.updated_at),
      sourceUrl: safeHttpUrl(bill.source_url),
    }));
  return billsCache;
}

function voteOption(voter) {
  const option = firstString(voter?.option, voter?.vote, voter?.value, voter?.position).toLowerCase();
  if (option === 'yes' || option === 'yea' || option === 'aye' || option === 'for') return 'Yes';
  if (option === 'no' || option === 'nay' || option === 'against') return 'No';
  if (option.includes('present')) return 'Present';
  if (option.includes('absent')) return 'Absent';
  if (option.includes('excused')) return 'Excused';
  return firstString(voter?.option, voter?.vote, voter?.value, voter?.position) || 'Recorded';
}

function voterMatchesPerson(voter, person) {
  const ids = [voter?.id, voter?.person_id, voter?.person?.id, voter?.voter?.id]
    .filter((value) => typeof value === 'string');
  if (person.personId && ids.includes(person.personId)) return true;
  const names = [voter?.name, voter?.person?.name, voter?.voter?.name]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  return Boolean(person.name && names.includes(person.name.trim().toLowerCase()));
}

function extractVoters(vote) {
  if (Array.isArray(vote?.voters)) return vote.voters;
  if (Array.isArray(vote?.votes)) return vote.votes;
  return [];
}

async function fetchVotingHistory(person, apiKey) {
  const bills = majorBillsForVoteHistory();
  if (!bills.length || !apiKey || !person.personId) {
    return { status: 'unavailable', checkedBillCount: bills.length, records: [] };
  }
  let successfulResponses = 0;
  const records = await Promise.all(bills.map(async (bill) => {
    try {
      if (!/^ocd-bill\/[A-Za-z0-9-]+$/.test(bill.id)) return null;
      const url = new URL(`${OPEN_STATES_BILL_URL}/${bill.id}`);
      url.searchParams.set('include', 'votes');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } });
      successfulResponses += 1;
      const votes = Array.isArray(body.votes) ? body.votes : [];
      const matchingVote = votes.find((vote) => extractVoters(vote).some((voter) => voterMatchesPerson(voter, person)));
      const matchingVoter = matchingVote && extractVoters(matchingVote).find((voter) => voterMatchesPerson(voter, person));
      return {
        billId: bill.id,
        identifier: bill.identifier,
        session: bill.session || '',
        title: bill.title,
        date: firstString(matchingVote?.start_date, matchingVote?.end_date, bill.updatedAt),
        vote: matchingVoter ? voteOption(matchingVoter) : 'Not recorded',
        voteStatus: matchingVoter ? 'recorded' : 'not_recorded',
        result: firstString(matchingVote?.result),
        sourceUrl: bill.sourceUrl,
      };
    } catch (error) {
      return null;
    }
  }));
  return {
    status: successfulResponses ? 'available' : 'unavailable',
    checkedBillCount: bills.length,
    records: records.filter(Boolean),
  };
}

async function fetchLegislators(latitude, longitude, apiKey) {
  if (!apiKey) throw lookupError(503, 'not_configured', 'Legislator lookup is not configured yet.');
  const url = new URL(OPEN_STATES_GEO_URL);
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lng', String(longitude));
  const body = await fetchJson(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } });
  const people = Array.isArray(body.results) ? body.results : Array.isArray(body.people) ? body.people : [];
  const normalized = people.map(normalizeLegislator).filter(Boolean);
  const byChamber = ['Senate', 'House'].map((chamber) => normalized.find((person) => person.chamber === chamber)).filter(Boolean);
  if (byChamber.length !== 2) throw lookupError(404, 'no_match', 'No Texas legislators matched that location.');
  return byChamber;
}

async function findLegislators(address, apiKey) {
  const key = cacheKeyForAddress(address);
  const cached = cache.get(key);
  if (cached && Date.now() - Number(cached.cachedAt) < CACHE_TTL_MS
    && cachedLegislatorsAreUsable(cached.legislators)) {
    return { legislators: cached.legislators, cached: true };
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const lookup = (async () => {
    const coordinates = isZipAddress(address) ? await geocodeZip(address) : await geocodeFullAddress(address);
    if (!(await isTexasCoordinate(coordinates.latitude, coordinates.longitude))) {
      throw lookupError(422, 'outside_texas', 'That location is outside Texas. Enter a Texas address or ZIP code.');
    }
    const legislators = await fetchLegislators(coordinates.latitude, coordinates.longitude, apiKey);
    await Promise.all(legislators.map(async (legislator) => {
      const history = await fetchVotingHistory(legislator, apiKey);
      legislator.votingHistoryStatus = history.status;
      legislator.votingHistoryChecked = history.checkedBillCount;
      legislator.votingHistory = history.records;
    }));
    if (cache.size > 2000) cache.clear();
    cache.set(key, { cachedAt: Date.now(), legislators });
    return { legislators, cached: false };
  })();
  inFlight.set(key, lookup);
  try { return await lookup; } finally { inFlight.delete(key); }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendJsonError(res, status, message, code) {
  sendJson(res, status, { ok: false, error: String(message), code });
}

async function readJsonBody(req) {
  // Vercel pre-parses JSON bodies into req.body when possible.
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try {
        const parsed = JSON.parse(req.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (error) { /* fall through to error below */ }
      throw lookupError(400, 'bad_request', 'Request body must be valid JSON.');
    }
    throw lookupError(400, 'bad_request', 'Request body must be a JSON object.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw lookupError(413, 'body_too_large', 'Request body too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw lookupError(400, 'bad_request', 'Request body must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error && error.code) throw error;
    throw lookupError(400, 'bad_request', 'Request body must be valid JSON.');
  }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJsonError(res, 405, 'Method not allowed', 'method');
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    return sendJsonError(res, 415, 'Content-Type must be application/json.', 'unsupported_media_type');
  }
  if (rateLimited(clientIp(req))) {
    return sendJsonError(res, 429, 'Too many lookup requests. Please try again later.', 'rate_limited');
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJsonError(res, Number(error.status) || 400, error.message || 'Invalid request.', error.code || 'bad_request');
  }
  const address = typeof body.address === 'string' ? sanitizedLookupInput(body.address) : '';
  if (!address) return sendJsonError(res, 400, 'Enter a Texas address or ZIP code.', 'invalid_address');
  if (address.length > MAX_ADDRESS_LENGTH) return sendJsonError(res, 400, 'That address is too long.', 'invalid_address');
  if (!isZipAddress(address) && !/[A-Za-z0-9]/.test(address)) {
    return sendJsonError(res, 400, 'Enter a valid address or ZIP code.', 'invalid_address');
  }
  try {
    const result = await findLegislators(address, process.env.OPEN_STATES_API_KEY || '');
    return sendJson(res, 200, { ok: true, address, legislators: result.legislators, cached: result.cached });
  } catch (error) {
    const status = Number(error.status) || 502;
    const code = error.code || 'lookup_failed';
    const message = status >= 500 ? 'We could not complete that lookup right now. Please try again later.' : error.message;
    return sendJsonError(res, status, message, code);
  }
};
