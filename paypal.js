// paypal.js — create invoice, return official short "pay" link (no send step)
// Live-safe: DIGITAL_GOODS category, optional policy, no item.description.

const BASE =
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
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

/* ------------- Helper: search by invoice_number with retries ------------- */
async function searchInvoiceByNumber(token, invoiceNumber, attempt = 0) {
  const narrow = {
    invoice_number: invoiceNumber,
    status: ['DRAFT', 'UNPAID'],
    page: 1,
    page_size: 20,
    total_required: false,
  };
  const broad = {
    invoice_number: invoiceNumber,
    page: 1,
    page_size: 20,
    total_required: false,
  };

  for (let i = attempt; i < 6; i++) {
    const wait = 250 + i * 150;
    if (i > 0) await sleep(wait);

    let res = await fetch(`${BASE}/v2/invoicing/search-invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(narrow),
    });
    let data = await res.json().catch(() => ({}));
    let match = Array.isArray(data.items)
      ? data.items.find((it) => it.detail?.invoice_number === invoiceNumber)
      : null;
    if (match?.id) return match.id;

    res = await fetch(`${BASE}/v2/invoicing/search-invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(broad),
    });
    data = await res.json().catch(() => ({}));
    match = Array.isArray(data.items)
      ? data.items.find((it) => it.detail?.invoice_number === invoiceNumber)
      : null;
    if (match?.id) return match.id;
  }
  return null;
}

/* ---- helper: sanitize & truncate plain text (for optional policy) ---- */
function cleanText(s, max = 1000) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, max);
}

/* ---------------- Create + Share (poll for "pay" link) ---------------- */
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  // Pull channelId (if present in our JSON reference)
  let channelId = null;
  try { channelId = JSON.parse(reference)?.channelId || null; } catch {}

  // Short, safe invoice_number (<= 24 chars)
  const ts36 = Date.now().toString(36);
  const ch6  = channelId ? `c${String(channelId).slice(-6)}` : '';
  let invoiceNumber = `iv${ts36}${ch6}`.slice(0, 24);
  if (invoiceNumber.length < 3) invoiceNumber = `iv${ts36}`.slice(0, 24);

  const recipientEmail =
    process.env.INVOICE_RECIPIENT_PLACEHOLDER ||
    process.env.SELLER_EMAIL ||
    'placeholder@example.com';

  // No default policy. If env is blank/undefined → no note/terms.
  const ENV_DESC_RAW = process.env.INVOICE_DESCRIPTION; // could be undefined or empty string
  const POLICY_TEXT = cleanText(ENV_DESC_RAW ?? '', 1000);
  const USE_POLICY = POLICY_TEXT.length > 0;

  // Build payload
  const payload = {
    detail: {
      currency_code: 'USD',
      invoice_number: invoiceNumber,
      reference,
      category_code: 'DIGITAL_GOODS', // disables shipping UI
      ...(USE_POLICY ? { note: POLICY_TEXT, terms_and_conditions: POLICY_TEXT } : {}),
    },
    invoicer: {
      name: {
        given_name: process.env.INVOICE_BRAND_NAME || 'Your',
        surname: 'Shop',
      },
      email_address: process.env.SELLER_EMAIL || undefined,
    },
    primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
    items: [
      {
        name: 'Digital Item',
        // Do not set item.description in Live — avoids 422s.
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: amountUSD },
      },
    ],
  };

  // ---- 1) CREATE (with idempotency) ----
  const createRes = await fetch(`${BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'PayPal-Request-Id': invoiceNumber, // idempotent key
    },
    body: JSON.stringify(payload),
  });

  let invoice = null;
  let createText = await createRes.text().catch(() => '');
  if (createText && createText.trim()) {
    try { invoice = JSON.parse(createText); } catch {}
  }
  if (!invoice?.id) {
    const loc = createRes.headers.get('location') || createRes.headers.get('Location');
    if (loc) {
      const parts = loc.split('/');
      const maybeId = parts[parts.length - 1];
      if (maybeId) invoice = { id: maybeId };
    }
  }

  // Fallback: search (indexing delay)
  if (!invoice?.id) {
    const recoveredId = await searchInvoiceByNumber(token, invoiceNumber, 0);
    if (recoveredId) {
      invoice = { id: recoveredId };
    } else {
      throw new Error('Create invoice failed: ' + (createText || `${createRes.status}`));
    }
  }

  // ---- 2) Poll for the official short "pay" link ----
  async function fetchInvoice() {
    const r = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    try { return await r.json(); } catch { return null; }
  }

  let payLink = null;
  // Try up to ~5 seconds with exponential-ish backoff
  for (let i = 0; i < 12 && !payLink; i++) {
    const current = await fetchInvoice();
    const links = current?.links || [];
    // Prefer the short link:
    payLink =
      links.find((l) => l.rel === 'pay')?.href ||
      // Fallback to any link that looks like the short format:
      links.find((l) => typeof l.href === 'string' && /\/invoice\/p\/#/.test(l.href))?.href ||
      // Last fallback: long payer_view link (works but not pretty)
      links.find((l) => l.rel === 'payer_view')?.href ||
      null;

    if (!payLink) {
      await sleep(250 + i * 350); // 250ms → ~4.1s total
    }
  }

  if (!payLink) {
    // As a final guard, build the long link so the button is never empty
    payLink = `https://${process.env.PAYPAL_MODE === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com'}/invoice/payerView/details/${invoice.id}`;
  }

  return { id: invoice.id, payLink };
}

/* ---------------- Fetch invoice by ID (for webhook recovery) ---------------- */
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

/* ---------------- Webhook verification ---------------- */
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
