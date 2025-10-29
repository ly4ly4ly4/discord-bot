// paypal.js — resilient create/search/send with retries + idempotency
// Live-safe: policy text optional; no default; never sets item.description.

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

/* ------------- Helper: payer link ------------- */
function extractPayerLink(full, invoiceId) {
  const links = full?.links || [];
  let payLink =
    links.find((l) => l.rel === 'payer_view')?.href ||
    links.find((l) => l.rel === 'pay')?.href ||
    full?.href ||
    null;

  if (!payLink) {
    const host =
      process.env.PAYPAL_MODE === 'live'
        ? 'www.paypal.com'
        : 'www.sandbox.paypal.com';
    payLink = `https://${host}/invoice/payerView/details/${invoiceId}`;
  }
  return payLink;
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

/* ---------------- Create + Send + Share ---------------- */
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

  // IMPORTANT: no default policy. If env is blank/undefined → no note/terms/description.
  const ENV_DESC_RAW = process.env.INVOICE_DESCRIPTION; // could be undefined or empty string
  const POLICY_TEXT = cleanText(ENV_DESC_RAW ?? '', 1000);
  const USE_POLICY = POLICY_TEXT.length > 0;

  // Build payload
  const payload = {
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
    primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
    items: [
      {
        name: 'Digital Item',
        // Deliberately omit item.description for Live safety (prevents 422 rejections).
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

  // ---- 2) Send if DRAFT ----
  await sleep(300);
  let getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let current = await getRes.json().catch(() => ({}));
  let status = current?.status || 'UNKNOWN';

  if (status === 'DRAFT') {
    async function trySend() {
      const r = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_to_invoicer: true }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '?');
        return { ok: false, status: r.status, body };
      }
      return { ok: true };
    }
    let send = await trySend();
    if (!send.ok && send.status === 404) {
      await sleep(700);
      send = await trySend();
    }
    if (!send.ok) throw new Error('Send invoice failed: ' + send.body);

    // refresh
    getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    current = await getRes.json().catch(() => ({}));
  }

  const payLink = extractPayerLink(current, invoice.id);
  if (!payLink) throw new Error('Could not find payer link on invoice');

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
