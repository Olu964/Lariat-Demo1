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
const OPEN_STATES_COMMITTEES_URL = 'https://v3.openstates.org/committees';
const COMMITTEES_CACHE_TTL_MS = 60 * 60 * 1000;

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
      && Array.isArray(person.votingHistory)
      && typeof person.committeesStatus === 'string'
      && Array.isArray(person.committees)
      && typeof person.sponsoredBillsStatus === 'string'
      && Array.isArray(person.sponsoredBills)
      && Array.isArray(person.leadershipRoles)
      && person.votingPattern && typeof person.votingPattern === 'object');
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
    roleTitle: firstString(role.title),
  };
}

// --- Profile enrichment: committees, sponsored bills, leadership, patterns ---

let committeesCache = { at: 0, list: null };

async function fetchTexasCommittees(apiKey) {
  const now = Date.now();
  if (committeesCache.list && now - committeesCache.at < COMMITTEES_CACHE_TTL_MS) {
    return committeesCache.list;
  }
  if (!apiKey) return [];
  const all = [];
  try {
    for (let page = 1; page <= 3; page += 1) {
      const url = new URL(OPEN_STATES_COMMITTEES_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      url.searchParams.set('include', 'memberships');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      if (!results.length) break;
      all.push(...results);
      const pagination = body?.pagination || {};
      if (Number(pagination.page) >= Number(pagination.max_page || page)) break;
      if (results.length < 100) break;
    }
  } catch (error) {
    return committeesCache.list || [];
  }
  committeesCache = { at: now, list: all };
  return all;
}

function uuidOfPersonId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('/');
  return parts[parts.length - 1].trim();
}

function normPersonName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function lastNameOf(fullName) {
  const tokens = normPersonName(fullName).split(' ').filter(Boolean)
    .filter((t) => !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(t));
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function personNamesMatch(a, b) {
  const na = normPersonName(a);
  const nb = normPersonName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  // "Gates, Gary" normalizes to "gates gary" — order-insensitive match.
  if (ta.length > 1 && ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return true;
  // Single-token forms ("KOLKHORST") match if contained in the full name.
  if ((ta.length === 1 && tb.includes(ta[0]) && ta[0].length >= 3)
    || (tb.length === 1 && ta.includes(tb[0]) && tb[0].length >= 3)) return true;
  const la = lastNameOf(na);
  const lb = lastNameOf(nb);
  // Last-name match catches "KOLKHORST" (sponsorship) vs "Lois Kolkhorst" (profile).
  if (la && la === lb && la.length >= 3) return true;
  // Surname may be first token in "Last, First" order.
  if (la && tb.includes(la) && la.length >= 3) return true;
  if (lb && ta.includes(lb) && lb.length >= 3) return true;
  return false;
}

function personIdsMatch(wantedId, candidateId) {
  const w = String(wantedId || '').trim();
  const c = String(candidateId || '').trim();
  if (!w || !c) return false;
  if (w === c) return true;
  return uuidOfPersonId(w) !== '' && uuidOfPersonId(w) === uuidOfPersonId(c);
}

function committeeMembershipPerson(membership) {
  if (!membership || typeof membership !== 'object') return { id: '', name: '' };
  const nested = membership.person && typeof membership.person === 'object' ? membership.person : null;
  const nestedId = typeof membership.person === 'string' ? membership.person : nested?.id;
  return {
    id: firstString(membership.person_id, membership.personId, membership.personIdHint, nestedId),
    name: firstString(membership.person_name, membership.name, membership.personName, nested?.name),
  };
}

function committeesForPerson(allCommittees, person) {
  const wantedId = String(person?.personId || '');
  const wantedName = String(person?.name || '');
  const wantedLast = lastNameOf(wantedName);
  const matched = [];
  for (const committee of allCommittees || []) {
    const memberships = Array.isArray(committee?.memberships) ? committee.memberships : [];
    const mine = memberships.find((m) => {
      const who = committeeMembershipPerson(m);
      if (wantedId && who.id && personIdsMatch(wantedId, who.id)) return true;
      if (personNamesMatch(wantedName, who.name)) return true;
      // Fallback: membership may carry only "Kolkhorst, Lois" style text in
      // an unexpected field — check every string value once.
      if (wantedLast && wantedLast.length >= 3) {
        const haystack = Object.values(m || {}).filter((v) => typeof v === 'string').join(' ').toLowerCase();
        if (haystack.includes(wantedLast) && normPersonName(haystack).includes(normPersonName(wantedName).split(' ')[0] || '___unlikely___')) return true;
      }
      return false;
    });
    if (!mine) continue;
    matched.push({
      id: firstString(committee?.id).slice(0, 120),
      name: firstString(committee?.name) || 'Committee',
      chamber: firstString(committee?.chamber).slice(0, 20),
      classification: firstString(committee?.classification).slice(0, 40),
      role: firstString(mine?.role) || 'Member',
    });
    if (matched.length >= 15) break;
  }
  matched.sort((a, b) => {
    const rank = (role) => (/chair/i.test(role || '') && !/vice/i.test(role || '') ? 0 : /vice/i.test(role || '') ? 1 : 2);
    return rank(a.role) - rank(b.role) || String(a.name).localeCompare(String(b.name));
  });
  return matched;
}

async function fetchSponsoredBills(person, apiKey) {
  if (!apiKey || (!person?.personId && !person?.name)) {
    return { status: 'unavailable', records: [] };
  }
  // personId can be "ocd-person/<uuid>" while /bills?sponsor sometimes only
  // matches the bare uuid or the surname ("KOLKHORST"). Try all forms so a
  // single strict query can't zero out the whole section.
  const seenQueries = new Set();
  const queries = [];
  for (const q of [person.personId, uuidOfPersonId(person.personId), person.name, lastNameOf(person.name)]) {
    if (typeof q === 'string' && q.trim() && !seenQueries.has(q.trim())) {
      seenQueries.add(q.trim());
      queries.push(q.trim());
    }
  }
  for (const sponsorQuery of queries) {
    try {
      const url = new URL(OPEN_STATES_BILL_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('sponsor', sponsorQuery);
      url.searchParams.set('per_page', '10');
      url.searchParams.set('sort', 'updated_desc');
      url.searchParams.set('include', 'sponsorships');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      if (!results.length) continue;
      const records = results.slice(0, 8).map((bill) => {
        const sponsorships = Array.isArray(bill?.sponsorships) ? bill.sponsorships : [];
        const mine = sponsorships.find((s) => {
          const sid = firstString(s?.person?.id, s?.person_id, typeof s?.person === 'string' ? s.person : '');
          const sname = firstString(s?.person?.name, s?.name);
          if (person.personId && sid && personIdsMatch(person.personId, sid)) return true;
          return personNamesMatch(person.name, sname);
        });
        const primary = mine ? mine.primary !== false : undefined;
        return {
          id: firstString(bill?.id).slice(0, 120),
          identifier: firstString(bill?.identifier).slice(0, 40),
          title: firstString(bill?.title).slice(0, 200) || 'Untitled bill',
          session: firstString(bill?.session).slice(0, 20),
          classification: (Array.isArray(bill?.classification) ? bill.classification.join(', ') : firstString(bill?.classification)).slice(0, 60),
          sponsorshipRole: firstString(mine?.classification, mine?.primary === true ? 'primary' : '').slice(0, 40),
          primary: primary === undefined ? null : Boolean(primary),
          latestAction: firstString(bill?.latest_action_description).slice(0, 200),
          latestActionDate: firstString(bill?.latest_action_date).slice(0, 20),
          sourceUrl: safeHttpUrl(bill?.openstates_url) || safeHttpUrl(bill?.sources?.[0]?.url),
        };
      }).filter((r) => r.identifier);
      if (records.length) return { status: 'available', records };
    } catch (error) { /* try next query */ }
  }
  return { status: 'unavailable', records: [] };
}

// --- Official Texas Legislature fallback (capitol.texas.gov, no API key) ---
// Open States committee coverage for Texas is experimental and often empty.
// The official Texas Legislature Online (TLO) publishes per-member committee
// assignments and authored-bill reports as plain HTML with stable URL shapes,
// so we scrape those (allowlisted host only) when Open States comes up empty.

const TLO_BASE = 'https://capitol.texas.gov';
const TLO_TIMEOUT_MS = 10_000;
const TLO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TLO_LEGS = ['89', '90'];
const TLO_REPORT_SESS = '89R';
const tloRosterCache = { at: 0, byChamber: null };
const tloMemberCache = new Map(); // code -> { at, committees, sponsored }

async function fetchTloText(pathAndQuery) {
  const url = new URL(pathAndQuery, TLO_BASE);
  if (url.host !== 'capitol.texas.gov' || url.protocol !== 'https:') {
    throw new Error('TLO host not allowed');
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'LariatLegislatorLookup/1.0 (+https://lariatdemo.com)', Accept: 'text/html' },
    signal: AbortSignal.timeout(TLO_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TLO HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length < 500) throw new Error('TLO empty response');
  return text;
}

function decodeTloEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseTloRoster(html) {
  const entries = [];
  const re = /<option\s+value="(A\d+)"[^>]*>([^<]+)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) && entries.length < 500) {
    const code = m[1].trim();
    const rawLabel = decodeTloEntities(m[2]);
    const label = rawLabel.replace(/\s*\([A-Z]-A\d+\)\s*$/, '').trim();
    if (code && label && !/select a name/i.test(label)) entries.push({ code, label });
  }
  return entries;
}

async function fetchTloRoster() {
  const now = Date.now();
  if (tloRosterCache.byChamber && now - tloRosterCache.at < TLO_CACHE_TTL_MS) {
    return tloRosterCache.byChamber;
  }
  const [houseHtml, senateHtml] = await Promise.all([
    fetchTloText('/Committees/ByMember.aspx?chamber=H'),
    fetchTloText('/Committees/ByMember.aspx?chamber=S'),
  ]);
  const byChamber = { H: parseTloRoster(houseHtml), S: parseTloRoster(senateHtml) };
  tloRosterCache.at = now;
  tloRosterCache.byChamber = byChamber;
  return byChamber;
}

function resolveTloCode(candidates, person) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length || !person?.name) return '';
  const exact = list.find((c) => personNamesMatch(person.name, c.label));
  if (exact && !list.some((o) => o !== exact && personNamesMatch(person.name, o.label)
    && normPersonName(o.label) !== normPersonName(exact.label))) return exact.code;
  // Surname-only fallback when unambiguous within the chamber.
  const surname = lastNameOf(person.name);
  if (surname && surname.length >= 3) {
    const hits = list.filter((c) => normPersonName(c.label).split(' ').includes(surname));
    if (hits.length === 1) return hits[0].code;
  }
  // If the exact pass was ambiguous, prefer the one whose full token set matches.
  const sortedWant = normPersonName(person.name).split(' ').filter(Boolean).sort().join(' ');
  const fullHits = list.filter((c) => normPersonName(c.label).split(' ').filter(Boolean).sort().join(' ') === sortedWant);
  if (fullHits.length === 1) return fullHits[0].code;
  return exact && fullHits.length !== 0 ? exact.code : '';
}

function parseTloCommittees(html, chamber) {
  const section = (() => {
    const m = /<div id="committeeAssignments">([\s\S]*?)<div id="legislativeInformation">/.exec(html);
    return m ? m[1] : html;
  })();
  const block = (() => {
    const parts = section.split(/Conference Committees/i);
    return parts[0] || '';
  })();
  const out = [];
  const re = /<a[^>]*>([^<]+)<\/a>\s*(\(([^)]*)\))?/gi;
  let m;
  while ((m = re.exec(block)) && out.length < 15) {
    const name = decodeTloEntities(m[1]).slice(0, 100);
    if (!name || /conference committee on/i.test(name)) continue;
    const roleRaw = decodeTloEntities(m[3] || '').slice(0, 40);
    out.push({
      id: '',
      name: name || 'Committee',
      chamber: String(chamber || '').slice(0, 20),
      classification: '',
      role: roleRaw || 'Member',
      source: 'official',
    });
  }
  const seen = new Set();
  return out.filter((c) => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTloAuthoredReport(html) {
  const rows = String(html || '').split(/<div class="row">/).slice(1);
  const out = [];
  for (const row of rows) {
    if (out.length >= 8) break;
    const link = /BillLookup\/History\.aspx\?LegSess=([^&"']+)(?:&amp;|&)Bill=([^"'<]+)["'][^>]*>([^<]+)<\/a/i.exec(row);
    if (!link) continue;
    const legSess = decodeTloEntities(link[1]).slice(0, 12);
    const billParam = decodeTloEntities(link[2]).replace(/\s+/g, ' ').trim().slice(0, 20);
    const identifier = decodeTloEntities(link[3]).replace(/\s+/g, ' ').trim().slice(0, 20)
      || billParam.replace(/^([A-Za-z]+)\s*0*(\d+)$/, (_, letters, num) => `${letters.toUpperCase()} ${Number(num)}`).slice(0, 20)
      || billParam;
    if (!identifier) continue;
    const action = /<b>Last Action:<\/b><\/div>\s*<div[^>]*>([^<]*)/i.exec(row);
    const caption = /<b>Caption<\/b>:\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i.exec(row);
    out.push({
      id: '',
      identifier,
      title: truncateCaption(decodeTloEntities((caption ? caption[1].replace(/<[^>]*>/g, ' ') : ''))) || 'Untitled bill',
      session: legSess,
      classification: '',
      sponsorshipRole: 'Author',
      primary: true,
      latestAction: decodeTloEntities(action ? action[1] : '').slice(0, 200),
      latestActionDate: '',
      sourceUrl: `${TLO_BASE}/BillLookup/History.aspx?LegSess=${encodeURIComponent(legSess)}&Bill=${encodeURIComponent(billParam)}`,
      source: 'official',
    });
  }
  return out;
}

// Short feed-style display title from a long official caption
// ("Relating to health and nutrition standards ..., including ..." →
// "Health and nutrition standards to promote healthy living ...").
function truncateCaption(value, max = 110) {
  let text = String(value || '').replace(/^\s*relating to\s+/i, '').trim();
  const cut = text.search(/;\s|\s+including\s+/i);
  if (cut > 24 && cut < max) text = text.slice(0, cut).trim();
  text = text.replace(/[\s,;:.]+$/, '');
  if (text.length <= max) return text.charAt(0).toUpperCase() + text.slice(1);
  const sliced = text.slice(0, max);
  const lastSpace = sliced.lastIndexOf(' ');
  const trimmed = (lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced).replace(/[\s,;:.]+$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1) + '…';
}

const tloTitleCache = new Map(); // normalized identifier -> { at, title }

// Prefer the short Open States title (the same style the bill feed uses)
// over the official caption. Best-effort: falls back to the trimmed caption.
async function enrichTloBillTitles(bills, apiKey) {
  if (!apiKey || !Array.isArray(bills) || !bills.length) return bills;
  await Promise.all(bills.map(async (bill) => {
    if (bill?.source !== 'official') return;
    const key = String(bill.identifier || '').replace(/\s+/g, '').toUpperCase();
    if (!key) return;
    const cached = tloTitleCache.get(key);
    if (cached && Date.now() - Number(cached.at) < TLO_CACHE_TTL_MS) {
      if (cached.title) bill.title = cached.title;
      return;
    }
    try {
      const url = new URL(OPEN_STATES_BILL_URL);
      url.searchParams.set('jurisdiction', 'Texas');
      url.searchParams.set('identifier', bill.identifier);
      url.searchParams.set('per_page', '5');
      const body = await fetchJson(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } });
      const results = Array.isArray(body?.results) ? body.results : [];
      const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
      const match = results.find((b) => norm(b?.identifier) === key) || null;
      const shortTitle = firstString(match?.title);
      if (shortTitle && shortTitle.length < 100 && !/^relating to\s/i.test(shortTitle)) {
        bill.title = shortTitle.slice(0, 200);
        if (tloTitleCache.size > 500) tloTitleCache.clear();
        tloTitleCache.set(key, { at: Date.now(), title: bill.title });
        return;
      }
    } catch (error) { /* keep caption fallback */ }
    if (tloTitleCache.size > 500) tloTitleCache.clear();
    tloTitleCache.set(key, { at: Date.now(), title: '' });
  }));
  return bills;
}

async function fetchTloProfile(person) {
  const chamberLetter = String(person?.chamber || '').toLowerCase() === 'senate' ? 'S'
    : String(person?.chamber || '').toLowerCase() === 'house' ? 'H' : '';
  if (!chamberLetter) return null;
  const roster = await fetchTloRoster();
  const code = resolveTloCode(roster[chamberLetter], person);
  if (!code) return null;
  const cached = tloMemberCache.get(code);
  if (cached && Date.now() - Number(cached.at) < TLO_CACHE_TTL_MS) return cached;
  if (tloMemberCache.size > 500) tloMemberCache.clear();
  let memberHtml = '';
  for (const leg of TLO_LEGS) {
    try {
      memberHtml = await fetchTloText(`/Members/MemberInfo.aspx?Chamber=${chamberLetter}&Code=${encodeURIComponent(code)}&Leg=${leg}`);
      if (memberHtml.includes('Committee Assignments')) break;
    } catch (error) { /* try next Leg */ }
  }
  if (!memberHtml.includes('Committee Assignments')) return null;
  const committees = parseTloCommittees(memberHtml, person.chamber);
  let sponsored = [];
  try {
    const reportHtml = await fetchTloText(`/reports/report.aspx?LegSess=${TLO_REPORT_SESS}&ID=author&Code=${encodeURIComponent(code)}`);
    sponsored = parseTloAuthoredReport(reportHtml);
  } catch (error) { sponsored = []; }
  const result = { code, committees, sponsored, at: Date.now() };
  tloMemberCache.set(code, result);
  return result;
}

function buildLeadershipRoles(person, committees) {
  const roles = [];
  const title = String(person?.roleTitle || '');
  const lower = title.toLowerCase();
  const isGeneric = /^(senator|representative|state senator|state representative)\s*$/i.test(title.trim())
    || !title.trim();
  if (title.trim() && !isGeneric
    && /(speaker|president|pro tempore|majority|minority|leader|whip|chair|vice-chair|vice chair|speaker pro)/i.test(title)) {
    roles.push({ title, detail: `${person?.chamber || ''} leadership`.trim() });
  }
  for (const committee of committees || []) {
    if (/chair|vice/i.test(committee.role || '')) {
      roles.push({ title: `${committee.role} — ${committee.name}`, detail: 'Committee leadership' });
    }
    if (roles.length >= 8) break;
  }
  return roles.slice(0, 8).map((r) => ({
    title: String(r.title || '').slice(0, 140),
    detail: String(r.detail || '').slice(0, 80),
  }));
}

function buildVotingPattern(votingHistory, checkedCount) {
  const records = Array.isArray(votingHistory) ? votingHistory : [];
  const recorded = records.filter((r) => r?.voteStatus === 'recorded');
  const yes = recorded.filter((r) => String(r.vote || '').toLowerCase() === 'yes').length;
  const no = recorded.filter((r) => String(r.vote || '').toLowerCase() === 'no').length;
  const other = Math.max(0, recorded.length - yes - no);
  const notRecorded = records.filter((r) => r?.voteStatus !== 'recorded').length;
  const yesPct = recorded.length ? Math.round((yes / recorded.length) * 100) : null;
  const noPct = recorded.length ? Math.round((no / recorded.length) * 100) : null;
  let trend = 'No clear trend yet';
  if (recorded.length >= 2) {
    if (yesPct >= 75) trend = 'Votes Yes most of the time';
    else if (noPct >= 75) trend = 'Votes No most of the time';
    else if (yesPct >= 55) trend = 'Leans Yes';
    else if (noPct >= 55) trend = 'Leans No';
    else trend = 'Mixed Yes/No record';
  } else if (recorded.length === 1) {
    trend = yes === 1 ? 'Single recorded Yes vote' : no === 1 ? 'Single recorded No vote' : 'Single recorded vote';
  }
  return {
    totalChecked: Number.isFinite(Number(checkedCount)) ? Number(checkedCount) : records.length,
    recorded: recorded.length,
    yes, no, other, notRecorded, yesPct, noPct, trend,
  };
}

async function enrichLegislator(legislator, apiKey, allCommittees) {
  const [history, sponsored] = await Promise.all([
    fetchVotingHistory(legislator, apiKey),
    fetchSponsoredBills(legislator, apiKey),
  ]);
  legislator.votingHistoryStatus = history.status;
  legislator.votingHistoryChecked = history.checkedBillCount;
  legislator.votingHistory = history.records;
  const committees = committeesForPerson(allCommittees, legislator);
  let committeesSource = committees.length ? 'openstates' : '';
  let sponsoredRecords = sponsored.records;
  let sponsoredStatus = sponsored.status;
  let sponsoredSource = sponsoredRecords.length ? 'openstates' : '';
  // Official TLO fallback (no key): fills committees + sponsored bills when
  // Open States has nothing. Best-effort — never fails the lookup.
  if (!committees.length || !sponsoredRecords.length) {
    try {
      const tlo = await fetchTloProfile(legislator);
      if (tlo) {
        if (!committees.length && tlo.committees.length) {
          committees.push(...tlo.committees.slice(0, 15));
          committeesSource = 'official';
        }
        if (!sponsoredRecords.length && tlo.sponsored.length) {
          sponsoredRecords = tlo.sponsored.slice(0, 8);
          sponsoredStatus = 'available';
          sponsoredSource = 'official';
        }
      }
      if (sponsoredSource === 'official' && sponsoredRecords.length) {
        await enrichTloBillTitles(sponsoredRecords, apiKey);
      }
      console.log(`[legislator] TLO fallback for ${legislator.name}: ${tlo ? `${tlo.committees.length} committees, ${tlo.sponsored.length} sponsored (code ${tlo.code})` : 'no TLO profile resolved'}`);
    } catch (error) {
      console.log(`[legislator] TLO fallback failed for ${legislator.name}: ${error.message}`);
    }
  }
  committees.sort((a, b) => {
    const rank = (role) => (/chair/i.test(role || '') && !/vice/i.test(role || '') ? 0 : /vice/i.test(role || '') ? 1 : 2);
    return rank(a.role) - rank(b.role) || String(a.name).localeCompare(String(b.name));
  });
  legislator.committees = committees.slice(0, 15);
  legislator.committeesStatus = committees.length ? 'available' : 'unavailable';
  legislator.committeesSource = committeesSource;
  legislator.sponsoredBills = sponsoredRecords.slice(0, 8);
  legislator.sponsoredBillsStatus = sponsoredStatus;
  legislator.sponsoredBillsSource = sponsoredSource;
  legislator.leadershipRoles = buildLeadershipRoles(legislator, committees);
  legislator.votingPattern = buildVotingPattern(history.records, history.checkedBillCount);
  return legislator;
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
    .slice(0, 12)
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
  const ids = [voter?.id, voter?.person_id, voter?.person?.id, voter?.voter?.id,
    typeof voter?.voter === 'string' ? voter.voter : '',
    typeof voter?.person === 'string' ? voter.person : '']
    .filter((value) => typeof value === 'string' && value);
  if (person?.personId && ids.some((id) => personIdsMatch(person.personId, id))) return true;
  const names = [voter?.name, voter?.person?.name, voter?.voter?.name, voter?.voter_name,
    typeof voter?.voter === 'string' ? voter.voter : '', typeof voter?.person === 'string' ? voter.person : '']
    .filter((value) => typeof value === 'string' && value.trim());
  return names.some((n) => personNamesMatch(person?.name, n));
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
  const clean = records.filter(Boolean);
  // Recent snapshots can include filed bills with no floor vote yet. Prefer
  // bills with an actual recorded vote so Recent votes / Voting patterns
  // rarely come back as 0-of-N.
  const recordedFirst = [...clean].sort((a, b) => (
    (b.voteStatus === 'recorded' ? 1 : 0) - (a.voteStatus === 'recorded' ? 1 : 0)
  ));
  return {
    status: successfulResponses ? 'available' : 'unavailable',
    checkedBillCount: bills.length,
    records: recordedFirst.slice(0, 6),
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
    const allCommittees = await fetchTexasCommittees(apiKey);
    await Promise.all(legislators.map((legislator) => enrichLegislator(legislator, apiKey, allCommittees)));
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
