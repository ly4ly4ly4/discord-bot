// paypal.js — Node's built-in fetch, plus small retry on /send

const BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Get an OAuth token from PayPal
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

// Create an invoice (USD only), send to invoicer, return a shareable payer link
async function createAndShareInvoice({ itemName, amountUSD, reference }) {
  const token = await getAccessToken();

  // 1) Create invoice (no primary_recipients)
  const createRes = await fetch(`${BASE}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
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
      items: [{
        name: itemName,
        quantity: "1",
        unit_amount: { currency_code: 'USD', value: amountUSD }
      }]
    })
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '?');
    throw new Error('Create invoice failed: ' + text);
  }

  const invoice = await createRes.json();
  if (!invoice?.id) throw new Error('Create invoice returned no id');
  console.log('[paypal] created invoice id:', invoice.id);

  // (Optional) read it back to confirm visibility and status
  await sleep(300); // tiny delay helps with occasional propagation lag
  let getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const before = await getRes.json().catch(() => ({}));
  console.log('[paypal] invoice status before send:', before?.status);

  // 2) Try to send (retry once on 404/RESOURCE_NOT_FOUND)
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
    console.warn('[paypal] send returned 404. Retrying once…', send.body);
    await sleep(600);
    send = await trySend();
  }
  if (!send.ok) throw new Error('Send invoice failed: ' + send.body);

  // 3) Fetch again to get the payer link
  getRes = await fetch(`${BASE}/v2/invoicing/invoices/${invoice.id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const full = await getRes.json();
  const payLink = (full?.links || []).find(l => l.rel === 'pay')?.href || full?.href || null;

  if (!payLink) throw new Error('Could not find payer link on invoice after send');

  return { id: invoice.id, payLink };
}

// Verify the webhook signature from PayPal
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
