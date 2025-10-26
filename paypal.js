// paypal.js — resilient create/search/send with retries + idempotency

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
  // Narrow search first (status filter), then broaden
  const payloadNarrow = {
    invoice_number: invoiceNumber,
    status: ['DRAFT', 'UNPAID'],
    page: 1,
    page_size: 20,
    total_required: false,
  };
  const payloadBroad = {
    invoice_number: invoiceNumber,
    page: 1,
    page_size: 20,
    total_required: false,
  };

  for (let i = attempt; i < 6; i++) {
    // 0,1,2,3,4,5 → wait 250, 400, 600, 800, 1000, 1200ms
    const wait = 250 + i * 150;
    if (i > 0) await sleep(wait);

    // Narrow
    let res = await fetch(`${BASE}/v2/invoicing/search-invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadNarrow),
    });
    let data = await res.json().catch(() => ({}));
    let match = Array.isArray(data.items)
      ? data.items.find((it) => it.detail?.invoice_number === invoiceNumber)
      : null;
    if (match?.id) return match.id;

    // Broad
    res = await fetch(`${BASE}/v2/invoicing/search-invoices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBroad),
    });
    data = await res.json().catch(() => ({}));
    match = Array.isArray(data.items)
      ? data.items.find((it) => it.detail?.invoice_number === invoiceNumber)
      : null;
    if (match?.id) return match.id;
  }
  return null;
}

/* ---------------- Create + Send + Share ---------------- */
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  let channelId = null;
  try {
    channelId = JSON.parse(reference)?.channelId || null;
  } catch {}

  // Use a unique, idempotent number. Also used for search.
  const invoiceNumber = channelId
    ? `ch_${channelId}_${Date.now()}`
    : `ts_${Date.now()}`;

  const recipientEmail =
    process.env.INVOICE_RECIPIENT_PLACEHOLDER ||
    process.env.SELLER_EMAIL ||
    'placeholder@example.com';

  // ---- 1) CREATE (ask for body; add idempotency header) ----
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
        note: itemName,
        terms_and_conditions: 'Digital goods. No shipping.',
      },
      invoicer: {
        name: {
          given_name: process.env.INVOICE_BRAND_NAME || 'Your',
          surname: 'Shop',
        },
        email_address: process.env.SELLER_EMAIL || undefined,
      },
      primary_recipients: [
        { billing_info: { email_address: recipientEmail } },
      ],
      items: [
        {
          name: itemName,
          quantity: '1',
          unit_amount: { currency_code: 'USD', value: amountUSD },
        },
      ],
    }),
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

  // ---- Fallback: retry search a few times (indexing delay) ----
  if (!invoice?.id) {
    console.warn('[paypal] create returned no ID; searching by invoice_number…');
    const recoveredId = await searchInvoiceByNumber(token, invoiceNumber, 0);
    if (recoveredId) {
      console.log('[paypal] recovered invoice id via search:', recoveredId);
      invoice = { id: recoveredId };
    } else {
      // Log status/body once to help diagnose PayPal oddities
      console.warn('[paypal] create status:', createRes.status);
      console.warn('[paypal] create body (truncated):', (createText || '').slice(0, 500));
    }
  }

  if (!invoice?.id) throw new Error('Create invoice returned no id');
  console.log('[paypal] created invoice id:', invoice.id);

  // Small delay then read invoice to get status
  await sleep(300);
  let getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let current = await getRes.json().catch(() => ({}));
  let status = current?.status || 'UNKNOWN';
  console.log('[paypal] invoice status before send:', status);

  // ---- 2) Only send when DRAFT ----
  if (status === 'DRAFT') {
    async function trySend() {
      const r = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_to_invoicer: true }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '?');
        return { ok: false, body, status: r.status };
      }
      return { ok: true };
    }

    let send = await trySend();
    if (!send.ok && send.status === 404) {
      console.warn('[paypal] send returned 404, retrying once…', send.body);
      await sleep(700);
      send = await trySend();
    }
    if (!send.ok) throw new Error('Send invoice failed: ' + send.body);

    // Refresh after send
    getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    current = await getRes.json().catch(() => ({}));
    status = current?.status || status;
  } else {
    console.log(`[paypal] invoice status is ${status}; skipping send.`);
  }

  // ---- 3) Return payer link ----
  const payLink = extractPayerLink(current, invoice.id);
  if (!payLink) throw new Error('Could not find payer link on invoice');

  return { id: invoice.id, payLink };
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
};
