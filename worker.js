/* ============================================================
   FLARE TO FLAME — Cloudflare Worker
   EXISTING (untouched):
   GET  /              → reads Services table
   GET  /staff         → reads Staff table (name + id only)
   GET  /offers        → reads Offers table
   POST /feedback      → writes one row to Feedback table

   NEW:
   POST /staff-lookup  → find staff by phone (login step 1)
   POST /send-otp      → generate 4-digit OTP, store in KV (10 min), send via WhatsApp
   POST /verify-otp    → check OTP against KV
   GET  /team          → public team list (name, role, photo)
   GET  /staff-status  → who is Available right now

   Token stored as SECRET (env.AIRTABLE_TOKEN), never in the app.
   OTP stored in KV binding: env.OTP_KV
   ============================================================ */

const BASE_ID = 'appK1bKgelTKXQKkR';
const SERVICES_TABLE = 'Services';
const STAFF_TABLE = 'Staff';
const FEEDBACK_TABLE = 'Feedback';
const OFFERS_TABLE = 'Offers';

const ALLOWED_ORIGIN = '*';

// OTP settings (Buddy's choice: 4-digit, 10-minute expiry)
const OTP_LENGTH = 4;
const OTP_TTL_SECONDS = 600; // 10 minutes

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

// Normalize a phone to digits only (e.g. "+91 97188 31333" -> "919718831333")
function normalizePhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

// Make a numeric OTP of OTP_LENGTH digits
function makeOtp() {
  let s = '';
  for (let i = 0; i < OTP_LENGTH; i++) {
    s += Math.floor(Math.random() * 10);
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
      // NEW ROUTES
      // ====================================================

      // ---- 5. STAFF LOOKUP (login step 1) ----
      // POST /staff-lookup  body: { phone: "919718831333" }
      // returns { found: true, id, name } if a staff member has that phone
      if (request.method === 'POST' && url.pathname === '/staff-lookup') {
        const body = await request.json();
        const phone = normalizePhone(body.phone);

        if (!phone) {
          return json({ found: false, error: 'No phone provided' }, 400);
        }

        // Pull staff with Name + Phone, then match in code (robust to format)
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const match = (data.records || []).find(rec => {
          const recPhone = normalizePhone(rec.fields && rec.fields.Phone);
          return recPhone && recPhone === phone;
        });

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
      // generates 4-digit OTP, stores in KV for 10 min, sends via WhatsApp (Composio)
      if (request.method === 'POST' && url.pathname === '/send-otp') {
        const body = await request.json();
        const phone = normalizePhone(body.phone);

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
          normalizePhone(rec.fields && rec.fields.Phone) === phone
        );
        if (!isStaff) {
          return json({ ok: false, error: 'Phone not registered' }, 404);
        }

        const otp = makeOtp();

        // Store in KV, auto-expires after 10 min
        await env.OTP_KV.put('otp:' + phone, otp, { expirationTtl: OTP_TTL_SECONDS });

        // ----------------------------------------------------
        // TODO: COMPOSIO WHATSAPP SEND — NOT WIRED YET
        // When Composio is ready, replace this block with the
        // real call. Needs: env.COMPOSIO_KEY (set as a secret)
        // and the WhatsApp send endpoint/action.
        // Message text suggestion:
        //   `Your Flare to Flame login code is ${otp}. Valid 10 minutes.`
        // ----------------------------------------------------
        const composioWired = false; // flip to true after wiring

        if (!composioWired) {
          // Placeholder mode: OTP is stored but not sent.
          // Returns the OTP in the response SO YOU CAN TEST.
          // REMOVE devOtp before going live with real sending.
          return json({
            ok: true,
            sent: false,
            note: 'Composio not wired yet. OTP stored in KV. devOtp shown for testing only.',
            devOtp: otp,
          });
        }

        // (Real send goes here once composioWired = true)
        return json({ ok: true, sent: true });
      }

      // ---- 7. VERIFY OTP ----
      // POST /verify-otp  body: { phone: "919718831333", otp: "1234" }
      if (request.method === 'POST' && url.pathname === '/verify-otp') {
        const body = await request.json();
        const phone = normalizePhone(body.phone);
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

        // Return the staff record for the session
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Phone&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const match = (data.records || []).find(rec =>
          normalizePhone(rec.fields && rec.fields.Phone) === phone
        );

        return json({
          ok: true,
          verified: true,
          id: match ? match.id : null,
          name: (match && match.fields && match.fields.Name) ? match.fields.Name : 'Staff',
        });
      }

      // ---- 8. TEAM (public team page) ----
      // GET /team  → name, role, photo for each staff member
      if (request.method === 'GET' && url.pathname === '/team') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Role&fields%5B%5D=Photo&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const team = (data.records || []).map(rec => {
          const f = rec.fields || {};
          let photo = '';
          if (f.Photo && f.Photo.length > 0 && f.Photo[0].url) {
            photo = f.Photo[0].url;
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
      // GET /staff-status  → name + available for each staff member
      // "available" = true when Staff Status field === "Active"
      if (request.method === 'GET' && url.pathname === '/staff-status') {
        const r = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${STAFF_TABLE}?fields%5B%5D=Name&fields%5B%5D=Staff%20Status&pageSize=100`,
          { headers: authHeader }
        );
        const data = await r.json();
        const status = (data.records || []).map(rec => {
          const f = rec.fields || {};
          const staffStatus = f['Staff Status'] || '';
          return {
            id: rec.id,
            name: f.Name || 'Staff',
            staffStatus: staffStatus,
            available: staffStatus === 'Active',
          };
        });
        return json({ status });
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
