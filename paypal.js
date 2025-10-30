// paypal.js — create + SEND via share-link (no email) and return the short /invoice/p/# link

const BASE =
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

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
  // Prefer the short “share” link
  const short = links.find((l) => /payer[-_]?view/i.test(l.rel) && /\/invoice\/p\//.test(l.href));
  if (short?.href) return short.href;
  // Fallback: sometimes the first send response has a direct short link at top-level href
  if (obj?.href && /\/invoice\/p\//.test(obj.href)) return obj.href;
  // Last resort (not ideal): the long details URL — we try to avoid returning this
  const long = links.find((l) => /payer[-_]?view|pay/i.test(l.rel));
  return long?.href || null;
}

/* ---------------- Create + Send (share link) + Return link ---------------- */
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  // optional policy text from env (blank means omit)
  const policyRaw = process.env.INVOICE_DESCRIPTION ?? '';
  const POLICY_TEXT = cleanText(policyRaw, 1000);
  const USE_POLICY = POLICY_TEXT.length > 0;

  // Build a short, safe invoice_number (<= 24 chars)
  let invoiceNumber = `iv${Date.now().toString(36)}`.slice(0, 24);

  // If you set a placeholder recipient email in env, we’ll include it;
  // otherwise we will SEND via share-link (no email required).
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
      // If recipientEmail is undefined, PayPal will still allow SEND via share link.
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
    // some responses only include Location header
    const loc = createRes.headers.get('location') || createRes.headers.get('Location');
    if (loc) created = { id: loc.split('/').pop() };
  }
  if (!created?.id) throw new Error('Create invoice failed: ' + (createTxt || createRes.status));

  const id = created.id;

  // 2) SEND — use share-link (no emails)
  // Docs: set send_to_invoicer=false and notification.send_to_recipient=false
  // so PayPal “sends” the invoice without emailing, and exposes the share link.
  async function sendWithShareLink() {
    const r = await fetch(`${BASE}/v2/invoicing/invoices/${id}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        send_to_invoicer: false,
        notification: { send_to_recipient: false },
      }),
    });
    const txt = await r.text().catch(() => '');
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
    // If API returns 422 due to missing recipient (older behaviors), this path still works,
    // because we are explicitly using the share-link notification.
    if (!r.ok && r.status !== 202 && r.status !== 200) {
      throw new Error(`Send invoice failed: ${txt || r.status}`);
    }
    return json || {};
  }

  let sendObj = await sendWithShareLink();

  // 3) Poll a few times for the short payer link
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
    // as a *very last* fallback, try constructing a details link (may not work until fully propagated)
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
