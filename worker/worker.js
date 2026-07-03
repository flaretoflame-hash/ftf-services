/* ============================================================
   FLARE TO FLAME — Cloudflare Worker  (v3 — 11 Jun 2026)
   EXISTING (untouched):
   GET  /              → reads Services table
   GET  /staff         → reads Staff table (name + id only)
   GET  /offers        → reads Offers table
   POST /feedback      → writes one row to Feedback table

   LOGIN (v2):
   POST /staff-lookup  → find staff by phone (login step 1)
   POST /send-otp      → generate 4-digit OTP, store in KV (10 min)
   POST /verify-otp    → check OTP; on success issues SESSION TOKEN (12h)
   GET  /team          → public team list (name, role, photo)
                         [FIXED v3: field is "Profile Photo" not "Photo"]
   GET  /staff-status  → who is available right now
                         [CHANGED v3: reads "Availability" field]

   NEW (v3):
   POST /set-availability → staff sets own availability (token required)

   NEW (v4 — online booking):
   GET  /booking-services  → active services (price only if Price Status=Live)
   GET  /booking-staff     → active staff who can do a service (Staff Skills)
   POST /check-availability→ ONE-BRAIN clash engine (staff+start+duration)
   POST /create-booking    → writes Appointment + Booking Lines, auto-creates Client

   NEW (v5 — 02 Jul 2026, receptionist + staff day view):
   /verify-otp now also returns + stores Role (session KV 'sess:role:<token>')
   GET  /day-schedule            → today's (or given date's) appointments.
                                    Receptionist role = all; other roles = own only.
   POST /update-appointment-status → Receptionist-only booking status change.

   Token stored as SECRET (env.AIRTABLE_TOKEN), never in the app.
   OTP + sessions stored in KV binding: env.OTP_KV
   ============================================================ */

const BASE_ID = 'appK1bKgelTKXQKkR';
const SERVICES_TABLE = 'Services';
const STAFF_TABLE = 'Staff';
const FEEDBACK_TABLE = 'Feedback';
const OFFERS_TABLE = 'Offers';
const APPOINTMENTS_TABLE = 'Appointments';
const BOOKING_LINES_TABLE = 'Booking Lines';
const STAFF_SKILLS_TABLE = 'Staff Skills';
const CLIENTS_TABLE = 'Clients';

/* ---- MARKETING / LEADS (added 20 Jun 2026 — comment-to-DM funnel) ----
   DORMANT until Meta app + Instagram Private Replies approval are live.
   New base "FTF Marketing" — separate from Salon OS base. */
const MARKETING_BASE = 'appfD8DRo3FMFuT8U';
const LEADS_TABLE = 'Leads';
/* Set these as Worker SECRETS once the Meta app exists (wrangler secret put):
   env.META_VERIFY_TOKEN  — any string you choose; must match the value you
                            type into the Meta webhook config screen.
   env.META_APP_SECRET    — from Meta App dashboard, to verify payload signature.
   env.IG_PAGE_TOKEN      — long-lived IG/Page access token for sending the auto-DM.
   KEYWORD_MAP below = which commented keyword triggers which DM + which post. */
const KEYWORD_MAP = {
  // Each keyword -> what to send + which post + which language (for the bilingual A/B test).
  // Use DIFFERENT keywords per language so Language lands cleanly in Airtable:
  //   'RESET':    { dm: 'Here is your free guide: <link>', post: 'Topic1-reset (EN)',  lang: 'EN' },
  //   'RESET-HI': { dm: 'Yeh raha aapka free guide: <link>', post: 'Topic1-reset (HI)', lang: 'Hinglish' },
};

const ALLOWED_ORIGIN = '*';

// OTP settings (4-digit, 10-minute expiry)
const OTP_LENGTH = 4;
const OTP_TTL_SECONDS = 600; // 10 minutes

// Session settings (issued after OTP verify)
const SESSION_TTL_SECONDS = 43200; // 12 hours = one work day

// The only values /set-availability accepts (must match Airtable
// "Availability" single-select options exactly)
const ALLOWED_AVAILABILITY = ['उपलब्ध', 'ब्रेक पर', 'आज छुट्टी'];

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Security headers (safe set — no CSP, so nothing can break Sentry/PostHog/images):
    'X-Content-Type-Options': 'nosniff',                       // no MIME-type guessing
    'X-Frame-Options': 'DENY',                                 // block clickjacking via iframes
    'Referrer-Policy': 'strict-origin-when-cross-origin',      // limit URL leakage to third parties
    'X-XSS-Protection': '0',                                   // modern-correct (old '1' is deprecated)
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

/* ── B1: CACHING ──
   Cloudflare's edge already gzip/brotli-compresses responses automatically
   (no manual gzip needed). What was missing: Cache-Control. Without it every
   visit re-hits Airtable's ~5 req/sec API. These read endpoints (services,
   offers, team) change rarely, so we cache them at the edge + in the browser.
   READ_CACHE_SECONDS is the one knob: a menu edit in Airtable shows within
   this window. 60s is a safe default for a 61-item menu. */
const READ_CACHE_SECONDS = 60;

function cachedJson(payload, seconds = READ_CACHE_SECONDS) {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...cors(),
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${seconds}, s-maxage=${seconds}`,
    },
  });
}

// Normalize a phone to digits only ("+91 97188 31333" -> "919718831333")
function normalizePhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

// Compare two phones by their LAST 10 DIGITS.
// Staff can type "9718831333" even if Airtable stores "919718831333".
function samePhone(a, b) {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  if (da.length < 10 || db.length < 10) return false;
  return da.slice(-10) === db.slice(-10);
}

// Make a numeric OTP of OTP_LENGTH digits
function makeOtp() {
  let s = '';
  for (let i = 0; i < OTP_LENGTH; i++) {
    s += Math.floor(Math.random() * 10);
  }
  return s;
}

// Make a random session token (32 hex chars, crypto-secure)
function makeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

// ----- BOOKING HELPERS -----

// Local YYYY-MM-DD for an ISO timestamp, used to match Appointments by Date.
function isoToDateStr(iso) {
  return String(iso || '').slice(0, 10);
}

// Today's date as YYYY-MM-DD in IST (Cloudflare Workers run in UTC).
// Used by /day-schedule when no explicit date is requested.
function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// Two time intervals overlap if each starts before the other ends.
// Touching edges (one ends exactly when next starts) is NOT a clash.
function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// The single source of truth for clash detection. Used by BOTH
// /check-availability (live UI) and /create-booking (server re-check),
// so receptionist + online booking share one brain → no cross-channel clash.
// Returns { available, clashes:[{appointmentId, start, end}] }
async function computeAvailability(env, authHeader, staffId, startISO, durationMins) {
  const dur = Number(durationMins) || 0;
  const newStart = new Date(startISO).getTime();
  const newEnd = newStart + dur * 60000;
  const dayStr = isoToDateStr(startISO);

  if (!staffId || !startISO || !dur || isNaN(newStart)) {
    return { available: false, error: 'staffId, startISO and durationMins required' };
  }

  // 1. Pull this staff's appointments on this day, excluding cancelled.
  //    filterByFormula keeps it to same staff + same Date + not Cancelled.
  const formula =
    `AND(` +
      `FIND('${staffId}', ARRAYJOIN({Staff})),` +
      `IS_SAME({Date}, '${dayStr}', 'day'),` +
      `{Status} != 'Cancelled'` +
    `)`;
  const apptUrl =
    `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(APPOINTMENTS_TABLE)}` +
    `?filterByFormula=${encodeURIComponent(formula)}` +
    `&fields%5B%5D=Start%20Time&fields%5B%5D=Booking%20Lines&fields%5B%5D=Status&fields%5B%5D=Total%20Duration&pageSize=100`;
  const apptRes = await fetch(apptUrl, { headers: authHeader });
  const apptData = await apptRes.json();
  const appts = apptData.records || [];

  if (appts.length === 0) {
    return { available: true, clashes: [] };
  }

  // B3: New bookings store Total Duration on the appointment, so the engine
  // reads it directly — no second call. Only LEGACY appointments (booked
  // before this field existed) still need the Booking Lines lookup.
  const lineIds = [];
  appts.forEach(a => {
    const f = a.fields || {};
    const hasStored = Number(f['Total Duration']) > 0;
    if (hasStored) return; // already have duration; skip line lookup for this appt
    const links = f['Booking Lines'] || [];
    links.forEach(id => lineIds.push(id));
  });

  // Map lineId -> duration. One batched read of Booking Lines (legacy rows only).
  const lineDur = {};
  if (lineIds.length > 0) {
    const orParts = lineIds.map(id => `RECORD_ID()='${id}'`).join(',');
    const lineFormula = `OR(${orParts})`;
    const lineUrl =
      `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(BOOKING_LINES_TABLE)}` +
      `?filterByFormula=${encodeURIComponent(lineFormula)}` +
      `&fields%5B%5D=Duration&pageSize=100`;
    const lineRes = await fetch(lineUrl, { headers: authHeader });
    const lineData = await lineRes.json();
    (lineData.records || []).forEach(l => {
      lineDur[l.id] = Number(l.fields && l.fields.Duration) || 0;
    });
  }

  // 3. For each existing appt compute its [start, end] and test overlap.
  const clashes = [];
  appts.forEach(a => {
    const st = a.fields && a.fields['Start Time'];
    if (!st) return; // no real timestamp -> can't clash-check, skip
    const exStart = new Date(st).getTime();
    if (isNaN(exStart)) return;
    const f = a.fields || {};
    // B3: prefer the stored Total Duration; fall back to summed legacy lines.
    let exDur = Number(f['Total Duration']) || 0;
    if (exDur <= 0) {
      const links = f['Booking Lines'] || [];
      let summed = 0;
      links.forEach(id => { summed += lineDur[id] || 0; });
      exDur = summed;
    }
    // If an appt still has no duration, treat as 30 min minimum block
    if (exDur <= 0) exDur = 30;
    const exEnd = exStart + exDur * 60000;
    if (intervalsOverlap(newStart, newEnd, exStart, exEnd)) {
      clashes.push({
        appointmentId: a.id,
        start: new Date(exStart).toISOString(),
        end: new Date(exEnd).toISOString(),
      });
    }
  });

  return { available: clashes.length === 0, clashes };
}


// FIX: HMAC-SHA256 hex helper for Meta webhook signature verification (Web Crypto).
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    const token = env.AIRTABLE_TOKEN;
    const authHeader = { Authorization: 'Bearer ' + token };

    try {
      // ====================================================
      // EXISTING ROUTES (unchanged)
      // ====================================================

      // ---- 1. READ SERVICES ----
      if (request.method === 'GET' && url.pathname === '/') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${SERVICES_TABLE}?pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        return cachedJson(data); // B1: edge+browser cache, 60s
      }

      // ---- 2. READ STAFF ----
      if (request.method === 'GET' && url.pathname === '/staff') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name`,
          { headers: authHeader }
        );
        const data = await r.json();
        const staff = (data.records || []).map(rec => ({
          id: rec.id,
          name: (rec.fields && rec.fields.Name) ? rec.fields.Name : 'Staff',
        }));
        return new Response(JSON.stringify({ staff }), {
          headers: { ...cors(), 'Content-Type': 'application/json' },
        });
      }

      // ---- 3. READ OFFERS ----
      if (request.method === 'GET' && url.pathname === '/offers') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${OFFERS_TABLE}?pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        return cachedJson(data); // B1: edge+browser cache, 60s
      }

      // ---- 4. WRITE FEEDBACK ----
      if (request.method === 'POST' && url.pathname === '/feedback') {
        const body = await request.json();

        const fields = {
          'Name': body.name || '',
          'Rating': Number(body.rating) || 0,
          'Hygiene': Number(body.hygiene) || 0,
          'What Did You Love': body.love || '',
          'What Can We Improve': body.improve || '',
          'Recommend Us': (body.recommend === 'Yes' || body.recommend === true),
        };

        if (body.staffId && body.staffId.indexOf('rec') === 0) {
          fields['Staff'] = [body.staffId];
        }

        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${FEEDBACK_TABLE}`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields }], typecast: true }),
          }
        );

        const result = await r.json();
        if (!r.ok) {
          return new Response(JSON.stringify({ ok: false, error: result }), {
            status: 400,
            headers: { ...cors(), 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors(), 'Content-Type': 'application/json' },
        });
      }

      // ====================================================
      // LOGIN ROUTES
      // ====================================================

      // ---- 5. STAFF LOOKUP (login step 1) ----
      // POST /staff-lookup  body: { phone: "919718831333" }
      if (request.method === 'POST' && url.pathname === '/staff-lookup') {
        const body = await request.json();
        const phone = normalizePhone(body.phone).slice(-10);

        if (!phone) {
          return json({ found: false, error: 'No phone provided' }, 400);
        }

        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const match = (data.records || []).find(rec =>
          samePhone(rec.fields && rec.fields.Phone, phone)
        );

        if (!match) {
          return json({ found: false });
        }
        return json({
          found: true,
          id: match.id,
          name: (match.fields && match.fields.Name) ? match.fields.Name : 'Staff',
        });
      }

      // ---- 6. SEND OTP ----
      // POST /send-otp  body: { phone: "919718831333" }
      if (request.method === 'POST' && url.pathname === '/send-otp') {
        const body = await request.json();
        const phone = normalizePhone(body.phone).slice(-10);

        if (!phone) {
          return json({ ok: false, error: 'No phone provided' }, 400);
        }

        // Only send OTP to a phone that belongs to a staff member
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const isStaff = (data.records || []).some(rec =>
          samePhone(rec.fields && rec.fields.Phone, phone)
        );
        if (!isStaff) {
          return json({ ok: false, error: 'Phone not registered' }, 404);
        }

        const otp = makeOtp();

        // Store in KV, auto-expires after 10 min
        await env.OTP_KV.put('otp:' + phone, otp, { expirationTtl: OTP_TTL_SECONDS });

        // ----------------------------------------------------
        // COMPOSIO WHATSAPP SEND
        // Flip composioWired to true when Composio is ready.
        // devOtp turns OFF automatically in the same step —
        // no separate "remove before launch" job.
        // Message text:
        //   `Your Flare to Flame login code is ${otp}. Valid 10 minutes.`
        // ----------------------------------------------------
        const composioWired = false; // SINGLE SWITCH: true = real send ON, devOtp OFF

        if (!composioWired) {
          // Testing mode only. devOtp dies automatically when composioWired = true.
          return json({
            ok: true,
            sent: false,
            note: 'Composio not wired yet. OTP stored in KV. devOtp shown for testing only.',
            devOtp: otp,
          });
        }

        // (Real Composio send goes here once composioWired = true)
        return json({ ok: true, sent: true });
      }

      // ---- 7. VERIFY OTP → ISSUE SESSION TOKEN ----
      // POST /verify-otp  body: { phone: "919718831333", otp: "1234" }
      // On success returns { ok, verified, id, name, sessionToken }
      if (request.method === 'POST' && url.pathname === '/verify-otp') {
        const body = await request.json();
        const phone = normalizePhone(body.phone).slice(-10);
        const otp = String(body.otp || '').trim();

        if (!phone || !otp) {
          return json({ ok: false, error: 'Phone and otp required' }, 400);
        }

        const stored = await env.OTP_KV.get('otp:' + phone);
        if (!stored) {
          return json({ ok: false, error: 'Code expired or not found' }, 400);
        }
        if (stored !== otp) {
          return json({ ok: false, error: 'Incorrect code' }, 400);
        }

        // Correct — delete so it can't be reused
        await env.OTP_KV.delete('otp:' + phone);

        // Find the staff record
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Phone&fields%5B%5D=Role&fields%5B%5D=Hamare%20Niyam%20Accepted&fields%5B%5D=Flare%20Score%20Terms%20Accepted&fields%5B%5D=Confidentiality%20Agreed&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const match = (data.records || []).find(rec =>
          samePhone(rec.fields && rec.fields.Phone, phone)
        );

        if (!match) {
          return json({ ok: false, error: 'Staff record not found' }, 404);
        }

        const role = (match.fields && match.fields.Role) ? match.fields.Role : '';

        // Issue session token (12h), stored in KV → value = staff record id.
        // ROLE (added 02 Jul 2026): stored under a separate 'sess:role:' key
        // so the original session shape (sess:<token> -> staffId string) is
        // untouched — /set-availability keeps working exactly as before.
        const sessionToken = makeToken();
        await env.OTP_KV.put('sess:' + sessionToken, match.id, {
          expirationTtl: SESSION_TTL_SECONDS,
        });
        await env.OTP_KV.put('sess:role:' + sessionToken, role, {
          expirationTtl: SESSION_TTL_SECONDS,
        });

        const consents = {
          hamareNiyam: !!(match.fields && match.fields['Hamare Niyam Accepted']),
          flareScoreTerms: !!(match.fields && match.fields['Flare Score Terms Accepted']),
          confidentiality: !!(match.fields && match.fields['Confidentiality Agreed']),
        };

        return json({
          ok: true,
          verified: true,
          id: match.id,
          name: (match.fields && match.fields.Name) ? match.fields.Name : 'Staff',
          role: role,
          consents: consents,
          sessionToken: sessionToken,
        });
      }

      // ---- 8. TEAM (public team page) ----
      // GET /team  → name, role, photo for each staff member
      // v3 FIX: photo field in Airtable is "Profile Photo", not "Photo"
      if (request.method === 'GET' && url.pathname === '/team') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Role&fields%5B%5D=Profile%20Photo&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const team = (data.records || []).map(rec => {
          const f = rec.fields || {};
          let photo = '';
          const photos = f['Profile Photo'];
          if (photos && photos.length > 0 && photos[0].url) {
            photo = photos[0].url;
          }
          return {
            id: rec.id,
            name: f.Name || 'Staff',
            role: f.Role || '',
            photo: photo,
          };
        });
        return cachedJson({ team }); // B1: edge+browser cache, 60s
      }

      // ---- 9. STAFF STATUS (who is available) ----
      // GET /staff-status
      // v3: "available" = employed (Staff Status = Active)
      //     AND self-set Availability = "उपलब्ध"
      if (request.method === 'GET' && url.pathname === '/staff-status') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Staff%20Status&fields%5B%5D=Availability&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const status = (data.records || []).map(rec => {
          const f = rec.fields || {};
          const staffStatus = f['Staff Status'] || '';
          const availability = f['Availability'] || '';
          return {
            id: rec.id,
            name: f.Name || 'Staff',
            staffStatus: staffStatus,
            availability: availability,
            available: staffStatus === 'Active' && availability === 'उपलब्ध',
          };
        });
        return json({ status });
      }

      // ---- 10. SET AVAILABILITY (token required) ----
      // POST /set-availability
      // body: { sessionToken: "...", availability: "उपलब्ध" | "ब्रेक पर" | "आज छुट्टी" }
      // Staff can ONLY change their own record (id comes from the token).
      if (request.method === 'POST' && url.pathname === '/set-availability') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        const availability = String(body.availability || '').trim();

        if (!sessionToken) {
          return json({ ok: false, error: 'Session token required' }, 401);
        }
        if (ALLOWED_AVAILABILITY.indexOf(availability) === -1) {
          return json({ ok: false, error: 'Invalid availability value' }, 400);
        }

        // Validate token → get staff record id
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) {
          return json({ ok: false, error: 'Session expired. Login again.' }, 401);
        }

        // Update ONLY the Availability field of the staff's own record
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}/${staffId}`,
          {
            method: 'PATCH',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: { 'Availability': availability },
              typecast: true,
            }),
          }
        );
        const result = await r.json();
        if (!r.ok) {
          return json({ ok: false, error: result }, 400);
        }

        return json({ ok: true, availability: availability });
      }

      // ====================================================
      // BOOKING ROUTES (v4 — online booking, one-brain clash check)
      // ====================================================

      // ---- 11. BOOKING SERVICES (client-safe service list) ----
      // GET /booking-services
      // Returns active services with name, category, subcategory, duration.
      // Price shown ONLY if Price Status = Live (Golden Rule: no internal numbers).
      if (request.method === 'GET' && url.pathname === '/booking-services') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(SERVICES_TABLE)}` +
          `?filterByFormula=${encodeURIComponent("{Active}=1")}` +
          `&fields%5B%5D=Service%20Name&fields%5B%5D=Category&fields%5B%5D=Subcategory` +
          `&fields%5B%5D=Duration%20Minutes&fields%5B%5D=Display%20Price&fields%5B%5D=Sort%20Order` +
          `&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const services = (data.records || []).map(rec => {
          const f = rec.fields || {};
          return {
            id: rec.id,
            name: f['Service Name'] || '',
            category: f['Category'] || '',
            subcategory: f['Subcategory'] || '',
            duration: Number(f['Duration Minutes']) || 0,
            // Display Price is blank unless Price Status = Live (gated formula)
            price: f['Display Price'] || '',
            sortOrder: Number(f['Sort Order']) || 0,
          };
        }).sort((a, b) => a.sortOrder - b.sortOrder);
        return json({ services });
      }

      // ---- 12. BOOKING STAFF (who can do this service) ----
      // GET /booking-staff?serviceId=recXXXX
      // Returns ACTIVE staff linked to this service via Staff Skills.
      // If no skills mapped for the service, falls back to all active staff.
      if (request.method === 'GET' && url.pathname === '/booking-staff') {
        const serviceId = url.searchParams.get('serviceId') || '';

        // Pull all active staff once (small table).
        const staffRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(STAFF_TABLE)}` +
          `?fields%5B%5D=Name&fields%5B%5D=Staff%20Status&fields%5B%5D=Availability&pageSize=100`,
          { headers: authHeader }
        );
        const staffData = await staffRes.json();
        const activeStaff = (staffData.records || []).filter(
          rec => (rec.fields && rec.fields['Staff Status']) === 'Active'
        );

        let allowedIds = null; // null = no skill filter (fallback)
        if (serviceId) {
          const skillFormula = `FIND('${serviceId}', ARRAYJOIN({Service}))`;
          const skillRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(STAFF_SKILLS_TABLE)}` +
            `?filterByFormula=${encodeURIComponent(skillFormula)}` +
            `&fields%5B%5D=Staff&pageSize=100`,
            { headers: authHeader }
          );
          const skillData = await skillRes.json();
          const skillRows = skillData.records || [];
          if (skillRows.length > 0) {
            allowedIds = new Set();
            skillRows.forEach(row => {
              const staffLinks = (row.fields && row.fields['Staff']) || [];
              staffLinks.forEach(id => allowedIds.add(id));
            });
          }
        }

        const staff = activeStaff
          .filter(rec => !allowedIds || allowedIds.has(rec.id))
          .map(rec => {
            const f = rec.fields || {};
            return {
              id: rec.id,
              name: f.Name || 'Staff',
              availability: f['Availability'] || '',
            };
          });

        return json({ staff, skillFiltered: allowedIds !== null });
      }

      // ---- 13. CHECK AVAILABILITY (the one-brain clash engine) ----
      // POST /check-availability
      // body: { staffId, startISO, durationMins }
      if (request.method === 'POST' && url.pathname === '/check-availability') {
        const body = await request.json();
        const result = await computeAvailability(
          env, authHeader, body.staffId, body.startISO, body.durationMins
        );
        const status = result.error ? 400 : 200;
        return json(result, status);
      }

      // ---- 14. CREATE BOOKING (write appt + lines, auto-create client) ----
      // POST /create-booking
      // body: {
      //   clientName, clientPhone,
      //   staffId, startISO, timeSlot,
      //   services: [{ id, duration }]   // one or more
      // }
      if (request.method === 'POST' && url.pathname === '/create-booking') {
        const body = await request.json();
        const clientName = String(body.clientName || '').trim();
        const clientPhone = normalizePhone(body.clientPhone).slice(-10);
        const staffId = String(body.staffId || '').trim();
        const startISO = String(body.startISO || '').trim();
        const timeSlot = String(body.timeSlot || '').trim();
        const services = Array.isArray(body.services) ? body.services : [];

        if (!clientName || !clientPhone || !staffId || !startISO || services.length === 0) {
          return json({ ok: false, error: 'Missing required booking fields' }, 400);
        }

        // Total duration = sum of chosen services' durations.
        const totalDuration = services.reduce(
          (sum, s) => sum + (Number(s.duration) || 0), 0
        );

        // SERVER-SIDE RE-CHECK — never trust the client. Same brain.
        const check = await computeAvailability(
          env, authHeader, staffId, startISO, totalDuration
        );
        if (!check.available) {
          return json({ ok: false, error: 'Slot no longer available', clashes: check.clashes || [] }, 409);
        }

        // B2: IDEMPOTENCY LOCK — stop a double-tapped "Confirm" from creating
        // two appointments. Same client + same staff + same start = one booking.
        // The lock lives 30s in KV; the real clash engine guards anything longer.
        const bookingKey = 'booklock:' + clientPhone + ':' + staffId + ':' + startISO;
        const already = await env.OTP_KV.get(bookingKey);
        if (already) {
          return json({ ok: false, error: 'This booking is already being processed.' }, 409);
        }
        await env.OTP_KV.put(bookingKey, '1', { expirationTtl: 30 });

        // 1. Find or auto-create the Client by last-10 phone match.
        let clientId = null;
        const cRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(CLIENTS_TABLE)}` +
          `?fields%5B%5D=Name&fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const cData = await cRes.json();
        const existing = (cData.records || []).find(rec =>
          samePhone(rec.fields && rec.fields.Phone, clientPhone)
        );
        if (existing) {
          clientId = existing.id;
        } else {
          const newC = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(CLIENTS_TABLE)}`,
            {
              method: 'POST',
              headers: { ...authHeader, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                records: [{ fields: { 'Name': clientName, 'Phone': clientPhone } }],
                typecast: true,
              }),
            }
          );
          const newCData = await newC.json();
          if (!newC.ok) {
            await env.OTP_KV.delete(bookingKey); // B2: nothing was created — free the lock for retry
            return json({ ok: false, error: 'Could not create client', detail: newCData }, 400);
          }
          clientId = newCData.records[0].id;
        }

        // 2. Create the Appointment (one booking id).
        const apptId = 'APT-' + Date.now();
        const apptFields = {
          'Appointment ID': apptId,
          'Client': [clientId],
          'Staff': [staffId],
          'Date': isoToDateStr(startISO),
          'Start Time': startISO,
          'Status': 'Booked',
          'Total Duration': totalDuration, // B3: stored so the clash engine reads it in ONE call (no Booking Lines lookup)
        };
        if (timeSlot) apptFields['Time Slot'] = timeSlot;

        const apptRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(APPOINTMENTS_TABLE)}`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields: apptFields }], typecast: true }),
          }
        );
        const apptData = await apptRes.json();
        if (!apptRes.ok) {
          await env.OTP_KV.delete(bookingKey); // B2: appointment not created — free the lock for retry
          return json({ ok: false, error: 'Could not create appointment', detail: apptData }, 400);
        }
        const appointmentRecId = apptData.records[0].id;

        // 3. Create one Booking Line per chosen service (child lines).
        //    Price At Booking left empty — price gate not live yet (Golden Rule).
        const lineRecords = services.map(s => ({
          fields: {
            'Appointment': [appointmentRecId],
            'Service': [s.id],
            'Assigned Staff': [staffId],
            'Duration': Number(s.duration) || 0,
          },
        }));
        const linesRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(BOOKING_LINES_TABLE)}`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: lineRecords, typecast: true }),
          }
        );
        const linesData = await linesRes.json();
        if (!linesRes.ok) {
          return json({
            ok: false,
            error: 'Appointment made but booking lines failed',
            appointmentId: appointmentRecId,
            detail: linesData,
          }, 400);
        }

        return json({
          ok: true,
          appointmentId: apptId,
          appointmentRecId,
          clientId,
          lines: (linesData.records || []).length,
        });
      }

      // ====================================================
      // RECEPTIONIST / STAFF SCHEDULE ROUTES (added 02 Jul 2026)
      // ONE BRAIN: reads the same Appointments + Booking Lines data
      // that /check-availability and /create-booking write to.
      // ====================================================

      // ---- 15. DAY SCHEDULE ----
      // GET /day-schedule?sessionToken=...&date=YYYY-MM-DD (date optional, default = today IST)
      // Receptionist role → sees ALL appointments for the day.
      // Any other staff role → sees ONLY appointments they are assigned to.
      if (request.method === 'GET' && url.pathname === '/day-schedule') {
        const sessionToken = String(url.searchParams.get('sessionToken') || '').trim();
        if (!sessionToken) {
          return json({ ok: false, error: 'Session token required' }, 401);
        }
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) {
          return json({ ok: false, error: 'Session expired. Login again.' }, 401);
        }
        const role = (await env.OTP_KV.get('sess:role:' + sessionToken)) || '';

        const dateParam = String(url.searchParams.get('date') || '').trim();
        const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : todayIST();

        const formula = encodeURIComponent(`{Date}='${dateStr}'`);
        const apptRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(APPOINTMENTS_TABLE)}` +
            `?filterByFormula=${formula}&fields%5B%5D=Appointment%20ID&fields%5B%5D=Client&fields%5B%5D=Staff` +
            `&fields%5B%5D=Time%20Slot&fields%5B%5D=Status&fields%5B%5D=Start%20Time&fields%5B%5D=Total%20Duration&pageSize=100`,
          { headers: authHeader }
        );
        const apptData = await apptRes.json();
        if (!apptRes.ok) {
          return json({ ok: false, error: apptData }, 400);
        }
        let records = apptData.records || [];

        // Non-receptionist roles see only their own appointments.
        if (role !== 'Receptionist') {
          records = records.filter(rec =>
            Array.isArray(rec.fields && rec.fields.Staff) &&
            rec.fields.Staff.indexOf(staffId) !== -1
          );
        }

        // Resolve client names in one extra call (small daily volume — fine at this scale).
        const clientIds = [...new Set(
          records.flatMap(rec => (rec.fields && rec.fields.Client) || [])
        )];
        let clientNames = {};
        if (clientIds.length > 0) {
          const clientFormula = encodeURIComponent(
            'OR(' + clientIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')'
          );
          const cRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(CLIENTS_TABLE)}` +
              `?filterByFormula=${clientFormula}&fields%5B%5D=Name&pageSize=100`,
            { headers: authHeader }
          );
          const cData = await cRes.json();
          if (cRes.ok) {
            (cData.records || []).forEach(rec => {
              clientNames[rec.id] = (rec.fields && rec.fields.Name) || 'Client';
            });
          }
        }

        // PERMISSION MATRIX (locked, App Details Notion page):
        // Receptionist = Full Name. Any other staff role = First Name ONLY.
        const firstNameOnly = s => String(s || 'Client').trim().split(/\s+/)[0] || 'Client';

        const appointments = records
          .map(rec => {
            const f = rec.fields || {};
            const cId = Array.isArray(f.Client) ? f.Client[0] : null;
            const fullName = cId ? (clientNames[cId] || 'Client') : 'Client';
            return {
              appointmentId: rec.id,
              apptCode: f['Appointment ID'] || '',
              clientName: (role === 'Receptionist') ? fullName : firstNameOnly(fullName),
              timeSlot: f['Time Slot'] || '',
              startTime: f['Start Time'] || '',
              duration: f['Total Duration'] || 0,
              status: f.Status || 'Booked',
              isMine: Array.isArray(f.Staff) && f.Staff.indexOf(staffId) !== -1,
            };
          })
          .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

        return json({ ok: true, date: dateStr, role: role, appointments: appointments });
      }

      // ---- 16. UPDATE APPOINTMENT STATUS ----
      // POST /update-appointment-status  { sessionToken, appointmentId, status }
      // Receptionist-only (front-desk owns the day's status changes).
      if (request.method === 'POST' && url.pathname === '/update-appointment-status') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        const appointmentId = String(body.appointmentId || '').trim();
        const status = String(body.status || '').trim();
        const ALLOWED_STATUS = ['Booked', 'In Progress', 'Completed', 'Cancelled', 'No Show'];

        if (!sessionToken) {
          return json({ ok: false, error: 'Session token required' }, 401);
        }
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) {
          return json({ ok: false, error: 'Session expired. Login again.' }, 401);
        }
        const role = (await env.OTP_KV.get('sess:role:' + sessionToken)) || '';
        if (role !== 'Receptionist') {
          return json({ ok: false, error: 'Only reception can update booking status' }, 403);
        }
        if (!appointmentId || ALLOWED_STATUS.indexOf(status) === -1) {
          return json({ ok: false, error: 'Invalid appointmentId or status' }, 400);
        }

        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(APPOINTMENTS_TABLE)}/${appointmentId}`,
          {
            method: 'PATCH',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { 'Status': status }, typecast: true }),
          }
        );
        const result = await r.json();
        if (!r.ok) {
          return json({ ok: false, error: result }, 400);
        }
        return json({ ok: true, appointmentId: appointmentId, status: status });
      }

      // ====================================================
      // BILLING (added 02 Jul 2026) — Receptionist-only checkout.
      // Closes the gap: Bills table existed in Airtable with ZERO app
      // code touching it. Commission (locked rule) can only trigger on
      // Completed + Paid — this endpoint is what makes "Paid" real.
      //
      // ASSUMPTION (flagged, confirm with Buddy): discount is applied to
      // the full MRP Total first; 18% GST is then charged only on the
      // GST-Applicable services' share of the discounted total.
      // If your real billing rule differs, tell me and this changes.
      // ====================================================

      // ---- 17. CREATE BILL ----
      // POST /create-bill
      // { sessionToken, appointmentId, discountType, tipAmount, paymentMode }
      if (request.method === 'POST' && url.pathname === '/create-bill') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        const appointmentId = String(body.appointmentId || '').trim();
        const discountType = String(body.discountType || 'None').trim();
        const tipAmount = Number(body.tipAmount) || 0;
        const paymentMode = String(body.paymentMode || 'Cash').trim();
        const DISCOUNT_TYPES = ['None', '10%', '20%', '30%', 'Flat 100', 'Flat 200', 'Flat 500'];

        if (!sessionToken) {
          return json({ ok: false, error: 'Session token required' }, 401);
        }
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) {
          return json({ ok: false, error: 'Session expired. Login again.' }, 401);
        }
        const role = (await env.OTP_KV.get('sess:role:' + sessionToken)) || '';
        if (role !== 'Receptionist') {
          return json({ ok: false, error: 'Only reception can create a bill' }, 403);
        }
        if (!appointmentId || DISCOUNT_TYPES.indexOf(discountType) === -1) {
          return json({ ok: false, error: 'Invalid appointmentId or discountType' }, 400);
        }

        // 1. Pull the appointment (need Client + Staff + Booking Lines).
        const apptRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(APPOINTMENTS_TABLE)}/${appointmentId}`,
          { headers: authHeader }
        );
        const appt = await apptRes.json();
        if (!apptRes.ok) {
          return json({ ok: false, error: 'Appointment not found' }, 404);
        }
        const af = appt.fields || {};
        const clientIds = af.Client || [];
        const staffIds = af.Staff || [];
        const lineIds = af['Booking Lines'] || [];
        if (lineIds.length === 0) {
          return json({ ok: false, error: 'No services on this booking — nothing to bill' }, 400);
        }

        // 2. Pull Booking Lines (Price At Booking + linked Service).
        const linesFormula = encodeURIComponent(
          'OR(' + lineIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')'
        );
        const linesRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(BOOKING_LINES_TABLE)}` +
            `?filterByFormula=${linesFormula}&fields%5B%5D=Price%20At%20Booking&fields%5B%5D=Service` +
            `&fields%5B%5D=Commission%20Staff&fields%5B%5D=Assigned%20Staff&pageSize=100`,
          { headers: authHeader }
        );
        const linesData = await linesRes.json();
        if (!linesRes.ok) {
          return json({ ok: false, error: linesData }, 400);
        }
        const lineRecs = linesData.records || [];

        // 3. Pull each linked Service's GST Applicable flag.
        const serviceIds = [...new Set(lineRecs.flatMap(r => (r.fields && r.fields.Service) || []))];
        let gstMap = {};
        if (serviceIds.length > 0) {
          const svcFormula = encodeURIComponent(
            'OR(' + serviceIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')'
          );
          const svcRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(SERVICES_TABLE)}` +
              `?filterByFormula=${svcFormula}&fields%5B%5D=GST%20Applicable&pageSize=100`,
            { headers: authHeader }
          );
          const svcData = await svcRes.json();
          if (svcRes.ok) {
            (svcData.records || []).forEach(r => { gstMap[r.id] = !!(r.fields && r.fields['GST Applicable']); });
          }
        }

        // 4. Compute MRP Total + Taxable Total from the lines.
        let mrpTotal = 0, taxableTotal = 0;
        lineRecs.forEach(r => {
          const price = Number(r.fields && r.fields['Price At Booking']) || 0;
          mrpTotal += price;
          const svcId = (r.fields && r.fields.Service && r.fields.Service[0]) || null;
          if (svcId && gstMap[svcId]) taxableTotal += price;
        });

        // 5. Discount.
        let discountAmount = 0;
        if (discountType === '10%') discountAmount = mrpTotal * 0.10;
        else if (discountType === '20%') discountAmount = mrpTotal * 0.20;
        else if (discountType === '30%') discountAmount = mrpTotal * 0.30;
        else if (discountType === 'Flat 100') discountAmount = 100;
        else if (discountType === 'Flat 200') discountAmount = 200;
        else if (discountType === 'Flat 500') discountAmount = 500;
        discountAmount = Math.min(discountAmount, mrpTotal);
        const discountedMrp = mrpTotal - discountAmount;

        // 6. GST — 18%, only on the GST-applicable share, after discount.
        const discountRatio = mrpTotal > 0 ? (discountedMrp / mrpTotal) : 0;
        const taxableAfterDiscount = taxableTotal * discountRatio;
        const gstAmount = Math.round(taxableAfterDiscount * 0.18);

        // 6.5 SPLIT COMMISSION (Point 4 — multi-service single booking).
        // Each Booking Line can name its own Commission Staff (built into the
        // schema already, separate from Assigned Staff — e.g. a senior stylist
        // getting credit for supervised work). Commission is calculated on the
        // DISCOUNTED SERVICE VALUE only — not on GST, not on tip. That's a
        // default assumption; tell Claude if FTF pays commission differently.
        let commissionBaseByStaff = {};
        lineRecs.forEach(r => {
          const price = Number(r.fields && r.fields['Price At Booking']) || 0;
          const lineShare = mrpTotal > 0 ? (price / mrpTotal) : 0;
          const lineDiscountedValue = discountedMrp * lineShare;
          let commStaff = (r.fields && r.fields['Commission Staff']) || [];
          if (commStaff.length === 0) commStaff = (r.fields && r.fields['Assigned Staff']) || [];
          if (commStaff.length === 0) return; // nothing to attribute
          const perHead = lineDiscountedValue / commStaff.length;
          commStaff.forEach(sid => {
            commissionBaseByStaff[sid] = (commissionBaseByStaff[sid] || 0) + perHead;
          });
        });

        const commStaffIds = Object.keys(commissionBaseByStaff);
        let commissionBreakdown = [];
        if (commStaffIds.length > 0) {
          const commFormula = encodeURIComponent(
            'OR(' + commStaffIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')'
          );
          const commRes = await fetch(
            `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?filterByFormula=${commFormula}` +
              `&fields%5B%5D=Name&fields%5B%5D=Commission%20Percent&pageSize=100`,
            { headers: authHeader }
          );
          const commData = await commRes.json();
          if (commRes.ok) {
            (commData.records || []).forEach(rec => {
              const pct = Number(rec.fields && rec.fields['Commission Percent']) || 0;
              const base = commissionBaseByStaff[rec.id] || 0;
              commissionBreakdown.push({
                staffId: rec.id,
                staffName: (rec.fields && rec.fields.Name) || 'Staff',
                commissionBase: Math.round(base),
                commissionPct: pct,
                commissionAmount: Math.round(base * (pct / 100)),
              });
            });
          }
        }

        // 7. Final.
        const finalAmount = Math.round(discountedMrp + gstAmount + tipAmount);

        // 8. Write the Bill.
        const billId = 'BILL-' + Date.now();
        const billRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Bills')}`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              records: [{
                fields: {
                  'Bill ID': billId,
                  'Client': clientIds,
                  'Staff': staffIds,
                  'MRP Total': Math.round(mrpTotal),
                  'Discount Type': discountType,
                  'Discount Amount': Math.round(discountAmount),
                  'GST Amount': gstAmount,
                  'Tip Amount': Math.round(tipAmount),
                  'Final Amount': finalAmount,
                  'Payment Mode': paymentMode,
                  'Date': todayIST(),
                },
              }],
              typecast: true,
            }),
          }
        );
        const billData = await billRes.json();
        if (!billRes.ok) {
          return json({ ok: false, error: billData }, 400);
        }

        return json({
          ok: true,
          billId: billId,
          mrpTotal: Math.round(mrpTotal),
          discountAmount: Math.round(discountAmount),
          gstAmount: gstAmount,
          tipAmount: Math.round(tipAmount),
          finalAmount: finalAmount,
          commissionBreakdown: commissionBreakdown, // NOTE: shown here, not yet persisted anywhere — Bills has no link back to this Appointment/Booking Lines. See Point 4 note in Notion.
        });
      }

      // ====================================================
      // A. JOIN FLOW — 3 CONSENTS (added 03 Jul 2026)
      // ====================================================

      // ---- 18. ACCEPT CONSENTS ----
      // POST /accept-consents { sessionToken }
      // Locks all 3 consents together (Hamare Niyam, Flare Score Terms,
      // Confidentiality). No field exists to un-accept — this is a
      // one-way door by design, matching the locked staff lifecycle rule.
      if (request.method === 'POST' && url.pathname === '/accept-consents') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}/${staffId}`,
          {
            method: 'PATCH',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                'Hamare Niyam Accepted': true,
                'Flare Score Terms Accepted': true,
                'Confidentiality Agreed': true,
              },
            }),
          }
        );
        const result = await r.json();
        if (!r.ok) return json({ ok: false, error: result }, 400);
        return json({ ok: true });
      }

      // ====================================================
      // B. ATTENDANCE CLOCK IN/OUT (added 03 Jul 2026)
      // NOTE: locked spec asks for selfie + GPS. The live Attendance
      // table has no fields for either (no attachment field, no
      // lat/lng field) — can't create fields via API. This builds
      // clock in/out on the fields that DO exist; selfie+GPS need
      // Buddy/Omni to add fields first.
      // ====================================================

      // ---- 19. CLOCK IN ----
      // POST /clock-in { sessionToken }
      if (request.method === 'POST' && url.pathname === '/clock-in') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const dateStr = todayIST();
        const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);

        // Don't double clock-in — check for an existing row today.
        const existFormula = encodeURIComponent(`AND({Date}='${dateStr}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const existRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}?filterByFormula=${existFormula}&pageSize=5`,
          { headers: authHeader }
        );
        const existData = await existRes.json();
        if (existRes.ok && existData.records && existData.records.length > 0) {
          return json({ ok: false, error: 'Already clocked in today', record: existData.records[0].fields }, 400);
        }

        const cRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              records: [{
                fields: {
                  'Staff': [staffId],
                  'Date': dateStr,
                  'Shift Type': 'Full',
                  'Check In Time': nowIST,
                  'Status': 'Present',
                },
              }],
              typecast: true,
            }),
          }
        );
        const cData = await cRes.json();
        if (!cRes.ok) return json({ ok: false, error: cData }, 400);
        return json({ ok: true, checkInTime: nowIST });
      }

      // ---- 20. CLOCK OUT ----
      // POST /clock-out { sessionToken }
      if (request.method === 'POST' && url.pathname === '/clock-out') {
        const body = await request.json();
        const sessionToken = String(body.sessionToken || '').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const dateStr = todayIST();
        const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
        const formula = encodeURIComponent(`AND({Date}='${dateStr}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const findRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}?filterByFormula=${formula}&pageSize=5`,
          { headers: authHeader }
        );
        const findData = await findRes.json();
        if (!findRes.ok || !findData.records || findData.records.length === 0) {
          return json({ ok: false, error: 'No clock-in found for today' }, 400);
        }
        const recId = findData.records[0].id;
        const uRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}/${recId}`,
          {
            method: 'PATCH',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { 'Check Out Time': nowIST } }),
          }
        );
        const uData = await uRes.json();
        if (!uRes.ok) return json({ ok: false, error: uData }, 400);
        return json({ ok: true, checkOutTime: nowIST });
      }

      // ---- 21. TODAY'S ATTENDANCE STATE ----
      // GET /attendance-today?sessionToken=...
      if (request.method === 'GET' && url.pathname === '/attendance-today') {
        const sessionToken = String(url.searchParams.get('sessionToken') || '').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const dateStr = todayIST();
        const formula = encodeURIComponent(`AND({Date}='${dateStr}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}?filterByFormula=${formula}&pageSize=5`,
          { headers: authHeader }
        );
        const data = await r.json();
        if (!r.ok) return json({ ok: false, error: data }, 400);
        if (!data.records || data.records.length === 0) {
          return json({ ok: true, clockedIn: false, checkInTime: null, checkOutTime: null });
        }
        const f = data.records[0].fields || {};
        return json({
          ok: true,
          clockedIn: true,
          checkInTime: f['Check In Time'] || null,
          checkOutTime: f['Check Out Time'] || null,
        });
      }

      // ====================================================
      // C. MY EARNINGS + MY SCORE (added 03 Jul 2026)
      // Score built HONESTLY: only 3 of 6 locked components have
      // real data behind them today (Revenue, Client Rating,
      // Attendance). Client Revisit Rate + Retail Attach need data
      // that nothing writes yet (Inventory Usage table is untouched,
      // revisit tracking doesn't exist) — returned as unavailable
      // rather than guessed, so staff never see a fabricated number.
      // ====================================================

      // ---- 22. MY EARNINGS ----
      // GET /my-earnings?sessionToken=&range=today|week|month
      if (request.method === 'GET' && url.pathname === '/my-earnings') {
        const sessionToken = String(url.searchParams.get('sessionToken') || '').trim();
        const range = String(url.searchParams.get('range') || 'today').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const now = new Date(Date.now() + 5.5 * 3600 * 1000);
        let startStr;
        if (range === 'week') {
          const d = new Date(now); d.setUTCDate(d.getUTCDate() - 6);
          startStr = d.toISOString().slice(0, 10);
        } else if (range === 'month') {
          startStr = now.toISOString().slice(0, 8) + '01';
        } else {
          startStr = now.toISOString().slice(0, 10);
        }

        const formula = encodeURIComponent(`AND({Date}>='${startStr}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Bills')}?filterByFormula=${formula}&fields%5B%5D=Final%20Amount&fields%5B%5D=Staff&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        if (!r.ok) return json({ ok: false, error: data }, 400);
        const recs = data.records || [];

        let total = 0;
        recs.forEach(rec => {
          const amt = Number(rec.fields && rec.fields['Final Amount']) || 0;
          const staffOnBill = (rec.fields && rec.fields.Staff) || [];
          // Multi-staff bill (rare under this schema) — split evenly. Single-staff = full credit.
          total += staffOnBill.length > 0 ? (amt / staffOnBill.length) : 0;
        });

        // Commission preview — only meaningful if this staff has a % set.
        const sRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}/${staffId}?fields%5B%5D=Commission%20Percent&fields%5B%5D=Salary%20Structure%20Type`,
          { headers: authHeader }
        );
        const sData = await sRes.json();
        const commissionPct = (sRes.ok && sData.fields && sData.fields['Commission Percent']) || 0;
        const commissionPreview = commissionPct > 0 ? Math.round(total * (commissionPct / 100)) : null;

        return json({
          ok: true,
          range: range,
          billCount: recs.length,
          totalEarnings: Math.round(total),
          commissionPreview: commissionPreview,
        });
      }

      // ---- 23. MY SCORE (partial, honest) ----
      // GET /my-score?sessionToken=...
      if (request.method === 'GET' && url.pathname === '/my-score') {
        const sessionToken = String(url.searchParams.get('sessionToken') || '').trim();
        if (!sessionToken) return json({ ok: false, error: 'Session token required' }, 401);
        const staffId = await env.OTP_KV.get('sess:' + sessionToken);
        if (!staffId) return json({ ok: false, error: 'Session expired. Login again.' }, 401);

        const now = new Date(Date.now() + 5.5 * 3600 * 1000);
        const monthStart = now.toISOString().slice(0, 8) + '01';

        // 1. Revenue Achievement (this month earnings / Monthly Target, capped 120%).
        const billFormula = encodeURIComponent(`AND({Date}>='${monthStart}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const billRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Bills')}?filterByFormula=${billFormula}&fields%5B%5D=Final%20Amount&fields%5B%5D=Staff&pageSize=100`,
          { headers: authHeader }
        );
        const billData = await billRes.json();
        let monthEarnings = 0;
        if (billRes.ok) {
          (billData.records || []).forEach(rec => {
            const amt = Number(rec.fields && rec.fields['Final Amount']) || 0;
            const n = ((rec.fields && rec.fields.Staff) || []).length || 1;
            monthEarnings += amt / n;
          });
        }
        const sRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}/${staffId}?fields%5B%5D=Monthly%20Target`,
          { headers: authHeader }
        );
        const sData = await sRes.json();
        const target = (sRes.ok && sData.fields && sData.fields['Monthly Target']) || 0;
        const revenuePct = target > 0 ? Math.min(120, Math.round((monthEarnings / target) * 100)) : null;

        // 2. Client Rating (average of Feedback.Rating for this staff, all-time).
        const fbFormula = encodeURIComponent(`FIND('${staffId}', ARRAYJOIN({Staff}))`);
        const fbRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Feedback')}?filterByFormula=${fbFormula}&fields%5B%5D=Rating&pageSize=100`,
          { headers: authHeader }
        );
        const fbData = await fbRes.json();
        let ratingAvg = null;
        if (fbRes.ok && fbData.records && fbData.records.length > 0) {
          const ratings = fbData.records.map(r => Number(r.fields && r.fields.Rating) || 0).filter(n => n > 0);
          if (ratings.length > 0) ratingAvg = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
        }

        // 3. Attendance & Punctuality (Present / total marked days this month).
        const attFormula = encodeURIComponent(`AND({Date}>='${monthStart}', FIND('${staffId}', ARRAYJOIN({Staff})))`);
        const attRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Attendance')}?filterByFormula=${attFormula}&fields%5B%5D=Status&pageSize=100`,
          { headers: authHeader }
        );
        const attData = await attRes.json();
        let attendancePct = null;
        if (attRes.ok && attData.records && attData.records.length > 0) {
          const present = attData.records.filter(r => (r.fields && r.fields.Status) === 'Present').length;
          attendancePct = Math.round((present / attData.records.length) * 100);
        }

        return json({
          ok: true,
          revenueAchievementPct: revenuePct,
          clientRatingAvg: ratingAvg,
          attendancePct: attendancePct,
          // Not computable today — nothing writes Inventory Usage or tracks revisits yet.
          clientRevisitRate: null,
          retailAttachPct: null,
        });
      }

      // ---- 24. ANONYMOUS LEADERBOARD ----
      // GET /leaderboard — % of Monthly Target achieved, no names, no amounts.
      if (request.method === 'GET' && url.pathname === '/leaderboard') {
        const now = new Date(Date.now() + 5.5 * 3600 * 1000);
        const monthStart = now.toISOString().slice(0, 8) + '01';

        const staffRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Monthly%20Target&fields%5B%5D=Staff%20Status&pageSize=100`,
          { headers: authHeader }
        );
        const staffData = await staffRes.json();
        if (!staffRes.ok) return json({ ok: false, error: staffData }, 400);
        const activeStaff = (staffData.records || []).filter(r => (r.fields && r.fields['Staff Status']) === 'Active');

        const billRes = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Bills')}?filterByFormula=${encodeURIComponent(`{Date}>='${monthStart}'`)}&fields%5B%5D=Final%20Amount&fields%5B%5D=Staff&pageSize=100`,
          { headers: authHeader }
        );
        const billData = await billRes.json();
        const earningsByStaff = {};
        if (billRes.ok) {
          (billData.records || []).forEach(rec => {
            const amt = Number(rec.fields && rec.fields['Final Amount']) || 0;
            const ids = (rec.fields && rec.fields.Staff) || [];
            ids.forEach(id => { earningsByStaff[id] = (earningsByStaff[id] || 0) + (amt / ids.length); });
          });
        }

        const board = activeStaff
          .map(s => {
            const target = (s.fields && s.fields['Monthly Target']) || 0;
            const earned = earningsByStaff[s.id] || 0;
            return target > 0 ? Math.min(120, Math.round((earned / target) * 100)) : null;
          })
          .filter(pct => pct !== null)
          .sort((a, b) => b - a);

        return json({ ok: true, leaderboard: board });
      }

      /* ============================================================
         MARKETING WEBHOOK — Instagram/Facebook comment-to-DM funnel
         STATUS: DORMANT. Code-ready; goes live only after the Meta app
         is created and Instagram Private Replies / template are approved.
         ============================================================ */

      // (A) Meta webhook VERIFICATION handshake (GET, one-time when you
      //     register the callback URL in the Meta App dashboard).
      if (request.method === 'GET' && url.pathname === '/meta-webhook') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        if (mode === 'subscribe' && token === (env.META_VERIFY_TOKEN || '')) {
          return new Response(challenge || '', { status: 200, headers: cors() });
        }
        return new Response('Forbidden', { status: 403, headers: cors() });
      }

      // (B) Meta COMMENT event (POST). Meta sends this when someone comments.
      //     We match the comment text against KEYWORD_MAP, write a lead row,
      //     and (once IG_PAGE_TOKEN is set) fire the one allowed Private Reply DM.
      if (request.method === 'POST' && url.pathname === '/meta-webhook') {
        // FIX: verify the payload really came from Meta (X-Hub-Signature-256 = HMAC-SHA256 of raw body with APP_SECRET).
        const rawBody = await request.text();
        if (env.META_APP_SECRET) {
          const sigHeader = request.headers.get('x-hub-signature-256') || '';
          const expected = await hmacSha256Hex(env.META_APP_SECRET, rawBody);
          if (sigHeader !== ('sha256=' + expected)) {
            return new Response('Invalid signature', { status: 401, headers: cors() });
          }
        }
        let body;
        try { body = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'bad json' }, 400); }

        // Meta payload shape: entry[].changes[].value { text, from, media_id, comment_id }
        const entries = Array.isArray(body.entry) ? body.entry : [];
        const results = [];
        for (const entry of entries) {
          const changes = Array.isArray(entry.changes) ? entry.changes : [];
          for (const ch of changes) {
            const v = (ch && ch.value) || {};
            const text = (v.text || '').trim();
            if (!text) continue;
            // case-insensitive keyword match (whole-word-ish)
            const upper = text.toUpperCase();
            const hitKey = Object.keys(KEYWORD_MAP).find(k => upper.includes(k.toUpperCase()));
            if (!hitKey) continue;

            const cfg = KEYWORD_MAP[hitKey] || {};
            const handle = (v.from && (v.from.username || v.from.name || v.from.id)) || 'unknown';

            // 1) Write the lead into FTF Marketing > Leads
            const leadFields = {
              'Lead Handle': String(handle),
              'Source': (body.object === 'instagram') ? 'Instagram' : 'Facebook',
              'Trigger Keyword': hitKey,
              'Trigger Post': cfg.post || (v.media_id || ''),
              'Status': 'New',
            };
            if (cfg.lang) leadFields['Language'] = cfg.lang; // FIX: language lands for the A/B test
            let leadWrite = { ok: false, recId: null };
            try {
              const r = await fetch(
                `https://api.airtable.com/v0/${MARKETING_BASE}/${encodeURIComponent(LEADS_TABLE)}`,
                { method: 'POST', headers: { ...authHeader, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ records: [{ fields: leadFields }], typecast: true }) }
              );
              const rd = await r.json().catch(() => ({}));
              leadWrite = { ok: r.ok, recId: (rd.records && rd.records[0] && rd.records[0].id) || null };
            } catch (e) { leadWrite = { ok: false, err: e.message }; }

            // 2) Send the ONE allowed Private Reply DM (only if token + comment_id present)
            let dmSent = false;
            if (env.IG_PAGE_TOKEN && v.comment_id && cfg.dm) {
              try {
                const dmRes = await fetch(
                  `https://graph.facebook.com/v21.0/${v.comment_id}/private_replies?access_token=${env.IG_PAGE_TOKEN}`,
                  { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: cfg.dm }) }
                );
                dmSent = dmRes.ok;
              } catch (e) { /* swallow — lead is already captured */ }
            }

            // 3) FIX: if the DM went out, advance the lead Status to "DM Sent"
            if (dmSent && leadWrite.recId) {
              try {
                await fetch(
                  `https://api.airtable.com/v0/${MARKETING_BASE}/${encodeURIComponent(LEADS_TABLE)}`,
                  { method: 'PATCH', headers: { ...authHeader, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ records: [{ id: leadWrite.recId, fields: { 'Status': 'DM Sent' } }], typecast: true }) }
                );
              } catch (e) { /* lead captured; status bump is best-effort */ }
            }
            results.push({ keyword: hitKey, handle, lead: leadWrite.ok, dm: dmSent });
          }
        }
        // Meta requires a fast 200 or it retries/disables the webhook.
        return json({ ok: true, processed: results.length, results });
      }

      return new Response('Not found', { status: 404, headers: cors() });

    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      });
    }
  },
};
