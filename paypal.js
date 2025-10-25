// paypal.js — Node's built-in fetch, placeholder recipient, ask for full body, retry /send

const BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1) OAuth
async function getAccessToken() {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
      ).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '?');
    throw new Error('PayPal OAuth failed: ' + text);
  }
  const data = await res.json();
  return data.access_token;
}

// 2) Create + send invoice, return payer link
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  // ---- IMPORTANT: provide a placeholder recipient email so PayPal will "send" the invoice
  const recipientEmail =
    process.env.INVOICE_RECIPIENT_PLACEHOLDER ||
    process.env.SELLER_EMAIL ||               // fallback if you set this
    'placeholder@example.com';                // last-resort format-only fallback

  // Create invoice. Ask PayPal to return the full representation.
  const createRes = await fetch(`${BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      detail: {
        currency_code: 'USD',
        invoice_number: `INV-${Date.now()}`,
        reference,
        note: itemName,
        terms_and_conditions: "Digital goods. No shipping."
      },
      invoicer: {
        name: { given_name: process.env.INVOICE_BRAND_NAME || "Your", surname: "Shop" },
        email_address: process.env.SELLER_EMAIL || undefined
      },
      // >>> This satisfies PayPal's "must have a recipient" rule
      primary_recipients: [{
        billing_info: { email_address: recipientEmail }
      }],
      items: [{
        name: itemName,
        quantity: "1",
        unit_amount: { currency_code: 'USD', value: amountUSD }
      }]
    })
  });

  // Handle empty body: fall back to Location header
  let invoice = null;
  let bodyText = await createRes.text().catch(() => '');
  if (bodyText && bodyText.trim().length > 0) {
    try { invoice = JSON.parse(bodyText); } catch { /* ignore */ }
  }
  if (!invoice?.id) {
    const loc = createRes.headers.get('location') || createRes.headers.get('Location');
    if (loc) {
      const parts = loc.split('/');
      const maybeId = parts[parts.length - 1];
      if (maybeId) invoice = { id: maybeId };
    }
  }
  if (!invoice?.id) {
    throw new Error('Create invoice returned no id');
  }
  console.log('[paypal] created invoice id:', invoice.id);

  await sleep(300); // small propagation delay

  // Optional: read status before send
  let getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const before = await getRes.json().catch(() => ({}));
  console.log('[paypal] invoice status before send:', before?.status);

  // Send (retry once on 404)
  async function trySend() {
    const r = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ send_to_invoicer: true })
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
    await sleep(600);
    send = await trySend();
  }
  if (!send.ok) throw new Error('Send invoice failed: ' + send.body);

  // Fetch again to get the payer link
  getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const full = await getRes.json().catch(() => ({}));
  const payLink = (full?.links || []).find(l => l.rel === 'pay')?.href || full?.href || null;

  if (!payLink) throw new Error('Could not find payer link on invoice after send');

  return { id: invoice.id, payLink };
}

// 3) Webhook verification
async function verifyWebhookSignature(req) {
  const token = await getAccessToken();
  const verifyRes = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_time: req.headers['paypal-transmission-time'],
      cert_url: req.headers['paypal-cert-url'],
      auth_algo: req.headers['paypal-auth-algo'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      webhook_id: process.env.WEBHOOK_ID || '',
      webhook_event: req.body
    })
  });
  const verify = await verifyRes.json().catch(() => ({}));
  return verify?.verification_status === 'SUCCESS';
}

module.exports = { createAndShareInvoice, verifyWebhookSignature };
