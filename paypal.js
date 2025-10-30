// paypal.js — create + send (with fallbacks) and return short /invoice/p/# link

const BASE =
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'        // ✅ live should use api-m
    : 'https://api-m.sandbox.paypal.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- OAuth ---------------- */
async function getAccessToken() {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(
          `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
        ).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '?');
    throw new Error('PayPal OAuth failed: ' + text);
  }
  const data = await res.json();
  return data.access_token;
}

/* ---- tiny helper ---- */
function cleanText(s, max = 1000) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, max);
}

/* ---- find a usable payer link from an invoice resource ---- */
function pickPayerLink(obj) {
  const links = Array.isArray(obj?.links) ? obj.links : [];
  const short = links.find((l) => /payer[-_]?view/i.test(l.rel) && /\/invoice\/p\//.test(l.href));
  if (short?.href) return short.href;
  if (obj?.href && /\/invoice\/p\//.test(obj.href)) return obj.href;
  const long = links.find((l) => /payer[-_]?view|pay/i.test(l.rel));
  return long?.href || null;
}

/* ---------------- Create + Send (with fallbacks) + Return link ---------------- */
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  // optional policy text from env (blank means omit)
  const policyRaw = process.env.INVOICE_DESCRIPTION ?? '';
  const POLICY_TEXT = cleanText(policyRaw, 1000);
  const USE_POLICY = POLICY_TEXT.length > 0;

  // short, safe invoice_number (<= 24 chars)
  let invoiceNumber = `iv${Date.now().toString(36)}`.slice(0, 24);

  const recipientEmail =
    (process.env.INVOICE_RECIPIENT_PLACEHOLDER || '').trim() || undefined;

  // 1) CREATE
  const createRes = await fetch(`${BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'PayPal-Request-Id': invoiceNumber,
    },
    body: JSON.stringify({
      detail: {
        currency_code: 'USD',
        invoice_number: invoiceNumber,
        reference,
        ...(USE_POLICY ? { note: POLICY_TEXT, terms_and_conditions: POLICY_TEXT } : {}),
      },
      invoicer: {
        name: {
          given_name: process.env.INVOICE_BRAND_NAME || 'Your',
          surname: 'Shop',
        },
        email_address: process.env.SELLER_EMAIL || undefined,
      },
      primary_recipients: recipientEmail
        ? [{ billing_info: { email_address: recipientEmail } }]
        : [],
      items: [
        {
          name: 'Digital Item',
          quantity: '1',
          unit_amount: { currency_code: 'USD', value: amountUSD },
        },
      ],
    }),
  });

  let created = null;
  const createTxt = await createRes.text().catch(() => '');
  if (createTxt) { try { created = JSON.parse(createTxt); } catch {} }
  if (!created?.id) {
    const loc = createRes.headers.get('location') || createRes.headers.get('Location');
    if (loc) created = { id: loc.split('/').pop() };
  }
  if (!created?.id) throw new Error('Create invoice failed: ' + (createTxt || createRes.status));
  const id = created.id;

  // 2) SEND — try a few body variants to satisfy different account policies
  async function trySend(body) {
    const r = await fetch(`${BASE}/v2/invoicing/invoices/${id}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text().catch(() => '');
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok && r.status !== 202 && r.status !== 200) {
      const err = new Error(txt || `send failed ${r.status}`);
      err._status = r.status;
      err._body = txt;
      throw err;
    }
    return json || {};
  }

  // strategies
  const bodies = [
    { send_to_invoicer: false, notification: { send_to_recipient: false } }, // share-link no email
    { send_to_invoicer: true,  notification: { send_to_recipient: false } }, // send copy to invoicer
    recipientEmail ? {} : { send_to_invoicer: true },                         // ultra-minimal fallback
  ];

  let sendObj = null;
  for (let i = 0; i < bodies.length; i++) {
    try {
      sendObj = await trySend(bodies[i]);
      break;
    } catch (e) {
      // If 422/400, continue to next body
      if (e?._status === 422 || e?._status === 400) continue;
      // other errors: surface
      throw new Error('Send invoice failed: ' + (e?._body || e?.message || e));
    }
  }
  if (!sendObj) throw new Error('Send invoice failed: all strategies rejected');

  // 3) Poll for short payer link
  let payerLink = pickPayerLink(sendObj);
  for (let i = 0; !payerLink && i < 10; i++) {
    await sleep(400 + i * 100);
    const g = await fetch(`${BASE}/v2/invoicing/invoices/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const inv = await g.json().catch(() => ({}));
    payerLink = pickPayerLink(inv);
  }
  if (!payerLink) {
    // last resort: details url (may 404 until fully propagated)
    payerLink = `https://www.paypal.com/invoice/payerView/details/${id}`;
  }

  return { id, payLink: payerLink };
}

/* ---------------- Read invoice (for webhook recovery) ---------------- */
async function getInvoiceById(invoiceId) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/invoicing/invoices/${invoiceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '?');
    throw new Error('getInvoiceById failed: ' + txt);
  }
  return res.json();
}

/* ---------------- Verify webhook ---------------- */
async function verifyWebhookSignature(req) {
  const token = await getAccessToken();
  const verifyRes = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_time: req.headers['paypal-transmission-time'],
      cert_url: req.headers['paypal-cert-url'],
      auth_algo: req.headers['paypal-auth-algo'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      webhook_id: process.env.WEBHOOK_ID || '',
      webhook_event: req.body,
    }),
  });
  const verify = await verifyRes.json().catch(() => ({}));
  return verify?.verification_status === 'SUCCESS';
}

module.exports = {
  createAndShareInvoice,
  verifyWebhookSignature,
  getInvoiceById,
};
