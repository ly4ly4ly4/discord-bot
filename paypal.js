// paypal.js — robust: create → send-to-invoicer → (fallback) add recipient & send → return short "pay" link
// Digital-safe: DIGITAL_GOODS; no item.description; optional policy; verbose logs for debugging.

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

/* ---- helper: sanitize & truncate plain text (for optional policy) ---- */
function cleanText(s, max = 1000) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, max);
}

async function fetchInvoiceJSON(token, id) {
  const r = await fetch(`${BASE}/v2/invoicing/invoices/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

function pickPayLink(inv) {
  const links = inv?.links || [];
  // Prefer the short link
  let pay =
    links.find((l) => l.rel === 'pay')?.href ||
    links.find((l) => typeof l.href === 'string' && /\/invoice\/p\/#/.test(l.href))?.href ||
    links.find((l) => l.rel === 'payer_view')?.href ||
    null;
  return pay;
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

  // Optional policy
  const ENV_DESC_RAW = process.env.INVOICE_DESCRIPTION; // undefined or empty ok
  const POLICY_TEXT = cleanText(ENV_DESC_RAW ?? '', 1000);
  const USE_POLICY = POLICY_TEXT.length > 0;

  // Build payload — NO primary_recipients initially
  const payload = {
    detail: {
      currency_code: 'USD',
      invoice_number: invoiceNumber,
      reference,
      category_code: 'DIGITAL_GOODS', // hide shipping / mark digital
      ...(USE_POLICY ? { note: POLICY_TEXT, terms_and_conditions: POLICY_TEXT } : {}),
    },
    invoicer: {
      name: {
        given_name: process.env.INVOICE_BRAND_NAME || 'Your',
        surname: 'Shop',
      },
      email_address: process.env.SELLER_EMAIL || undefined,
    },
    items: [
      {
        name: 'Digital Item',
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
  if (createText && createText.trim()) { try { invoice = JSON.parse(createText); } catch {} }

  if (!invoice?.id) {
    const loc = createRes.headers.get('location') || createRes.headers.get('Location');
    if (loc) {
      const parts = loc.split('/');
      const maybeId = parts[parts.length - 1];
      if (maybeId) invoice = { id: maybeId };
    }
  }
  if (!invoice?.id) throw new Error('Create invoice failed: ' + (createText || `${createRes.status}`));

  console.log('[paypal] created invoice id:', invoice.id);

  // ---- 2) Try SEND to invoicer (publishes share link on many accounts)
  let sendOk = false;
  try {
    const sendRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ send_to_invoicer: true }),
    });
    sendOk = sendRes.ok || sendRes.status === 202;
    if (!sendOk) {
      const t = await sendRes.text().catch(() => '?');
      console.log('[paypal] send_to_invoicer rejected:', sendRes.status, t.slice(0, 500));
    } else {
      console.log('[paypal] send_to_invoicer accepted');
    }
  } catch (e) {
    console.log('[paypal] send_to_invoicer error:', e?.message || e);
  }

  // ---- 3) Poll a few times for short "pay" link
  let payLink = null;
  for (let i = 0; i < 10 && !payLink; i++) {
    const current = await fetchInvoiceJSON(token, invoice.id);
    if (current) {
      console.log('[paypal] poll', i, 'status:', current?.status, 'links:', JSON.stringify(current?.links || [], null, 2));
      payLink = pickPayLink(current);
    }
    if (!payLink) await sleep(300 + i * 250); // ~0.3s → ~2.7s
  }

  // ---- 4) Fallback: if no short link, add a recipient and send to recipient, then poll again
  if (!payLink) {
    const recipientEmail =
      process.env.INVOICE_RECIPIENT_PLACEHOLDER ||
      process.env.SELLER_EMAIL ||
      null;

    if (recipientEmail) {
      // PATCH primary_recipients
      try {
        const patchRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([
            { op: 'replace', path: '/primary_recipients', value: [{ billing_info: { email_address: recipientEmail } }] }
          ]),
        });
        console.log('[paypal] patch recipients status:', patchRes.status);
      } catch (e) {
        console.log('[paypal] patch recipients error:', e?.message || e);
      }

      // Send to recipient
      try {
        const sendRes2 = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ send_to_invoicer: true, send_to_recipient: true }),
        });
        console.log('[paypal] send_to_recipient status:', sendRes2.status);
      } catch (e) {
        console.log('[paypal] send_to_recipient error:', e?.message || e);
      }

      // Poll again longer
      for (let i = 0; i < 12 && !payLink; i++) {
        const current = await fetchInvoiceJSON(token, invoice.id);
        if (current) {
          console.log('[paypal] poll+recipient', i, 'status:', current?.status, 'links:', JSON.stringify(current?.links || [], null, 2));
          payLink = pickPayLink(current);
        }
        if (!payLink) await sleep(350 + i * 350); // up to ~5s
      }
    } else {
      console.log('[paypal] no recipient email available for fallback send');
    }
  }

  // Final fallback so your button is never empty (may 404 if PayPal hasn’t published yet)
  if (!payLink) {
    const host = process.env.PAYPAL_MODE === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com';
    payLink = `https://${host}/invoice/payerView/details/${invoice.id}`;
    console.log('[paypal] returning long payerView fallback:', payLink);
  } else {
    console.log('[paypal] returning pay link:', payLink);
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
