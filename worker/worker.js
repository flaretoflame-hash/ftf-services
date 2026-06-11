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

   Token stored as SECRET (env.AIRTABLE_TOKEN), never in the app.
   OTP + sessions stored in KV binding: env.OTP_KV
   ============================================================ */

const BASE_ID = 'appK1bKgelTKXQKkR';
const SERVICES_TABLE = 'Services';
const STAFF_TABLE = 'Staff';
const FEEDBACK_TABLE = 'Feedback';
const OFFERS_TABLE = 'Offers';

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
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
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
        return new Response(JSON.stringify(data), {
          headers: { ...cors(), 'Content-Type': 'application/json' },
        });
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
        return new Response(JSON.stringify(data), {
          headers: { ...cors(), 'Content-Type': 'application/json' },
        });
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
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const match = (data.records || []).find(rec =>
          samePhone(rec.fields && rec.fields.Phone, phone)
        );

        if (!match) {
          return json({ ok: false, error: 'Staff record not found' }, 404);
        }

        // Issue session token (12h), stored in KV → value = staff record id
        const sessionToken = makeToken();
        await env.OTP_KV.put('sess:' + sessionToken, match.id, {
          expirationTtl: SESSION_TTL_SECONDS,
        });

        return json({
          ok: true,
          verified: true,
          id: match.id,
          name: (match.fields && match.fields.Name) ? match.fields.Name : 'Staff',
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
        return json({ team });
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

      return new Response('Not found', { status: 404, headers: cors() });

    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500,
        headers: { ...cors(), 'Content-Type': 'application/json' },
      });
    }
  },
};
