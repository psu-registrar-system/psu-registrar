// Payment logic. It knows nothing about Firebase or PayMongo directly: both are passed in
// (a "store" and a "gateway"), which is what lets it be tested without either.
import crypto from 'node:crypto';

export const HOLD_HOURS = 24;                       // how long an unpaid online request is kept
export const QR_EXPIRY_SECONDS = 1800;              // how long one QR code stays valid (30 minutes)
export const CLEANUP_GRACE_MS = 60 * 60 * 1000;     // never clean up within an hour after the hold ends
export const MIN_SECONDS_BETWEEN_QR = 5;            // stops rapid repeated requests for new QR codes
const REFERENCE_PATTERN = /^[OC][ABCDX]{4}[0-9]{4,}$/;

const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });

// ---------- webhook signature ----------
// PayMongo sends: Paymongo-Signature: t=<timestamp>,te=<test signature>,li=<live signature>
// signature = HMAC-SHA256( "<timestamp>.<raw body>", webhook secret ), hex
export function verifyWebhookSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const parts = {};
  String(header).split(',').forEach((p) => { const i = p.indexOf('='); if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  if (!parts.t) return false;

  let livemode = false;
  try { livemode = !!JSON.parse(rawBody)?.data?.attributes?.livemode; } catch { return false; }
  const received = livemode ? parts.li : parts.te;
  if (!received) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(received), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isCronAuthorized(authHeader, secret) {
  if (!secret || !authHeader) return false;
  const a = Buffer.from(`Bearer ${secret}`);
  const b = Buffer.from(String(authHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function paymentInfoFromIntent(intent) {
  const p = (intent.payments && intent.payments[0]) || {};
  return {
    paymentId: p.id || `intent_${intent.id}`,
    paymentIntentId: intent.id,
    amountCentavos: p.amount != null ? p.amount : intent.amount,
    currency: p.currency || intent.currency || 'PHP',
    livemode: !!intent.livemode,
  };
}

// ---------- create a QR code for an online request ----------
export async function createPaymentFlow({ reference }, { store, gateway, now = Date.now }) {
  if (!REFERENCE_PATTERN.test(reference || '')) return fail(400, 'That reference number does not look right.');

  const req = await store.getRequest(reference);
  if (!req) return fail(404, 'Request not found.');
  if (req.payment !== 'Online') return fail(400, 'This request is not an online payment.');
  if (req.paymentStatus === 'Paid') return ok({ paid: true });
  if (req.paymentStatus !== 'Awaiting Payment') return fail(400, 'This request is not waiting for payment.');

  const t = now();
  if (!req.createdAtMs || t - req.createdAtMs > HOLD_HOURS * 3600 * 1000) {
    return fail(410, 'The payment window for this request has ended. Please submit a new request.');
  }
  if (req.qrCreatedAtMs && t - req.qrCreatedAtMs < MIN_SECONDS_BETWEEN_QR * 1000) {
    return fail(429, 'Please wait a few seconds before asking for a new QR code.');
  }
  if (!(req.amount > 0)) return fail(400, 'This request has no amount to pay.');

  try {
    // An earlier QR may already have been paid, or may still be open: settle or cancel it first
    if (req.paymentIntentId) {
      const old = await gateway.getIntent(req.paymentIntentId).catch(() => null);
      if (old && old.status === 'succeeded') {
        await store.markPaid(reference, paymentInfoFromIntent(old));
        return ok({ paid: true });
      }
      if (old) await gateway.cancelIntent(req.paymentIntentId).catch(() => {});
    }

    const intent = await gateway.createIntent({
      amountCentavos: Math.round(req.amount * 100),
      description: `PSU document request ${reference}`,
      reference,
    });
    const method = await gateway.createQrMethod({ expirySeconds: QR_EXPIRY_SECONDS });
    const attached = await gateway.attach({ intentId: intent.id, methodId: method.id, clientKey: intent.clientKey });
    if (!attached.imageUrl) throw new Error('PayMongo did not return a QR code');

    await store.setPaymentIntent(reference, { paymentIntentId: intent.id, qrCreatedAtMs: t, qrExpiresAtMs: t + QR_EXPIRY_SECONDS * 1000 });
    return ok({ paid: false, qr: attached.imageUrl, expiresAt: t + QR_EXPIRY_SECONDS * 1000, amount: req.amount });
  } catch (error) {
    console.error('create-payment failed:', error);
    return fail(502, 'Could not create the payment right now. Please try again in a moment.');
  }
}

// ---------- "I already paid": ask PayMongo directly ----------
export async function checkPaymentFlow({ reference }, { store, gateway }) {
  if (!REFERENCE_PATTERN.test(reference || '')) return fail(400, 'That reference number does not look right.');
  const req = await store.getRequest(reference);
  if (!req) return fail(404, 'Request not found.');
  if (req.paymentStatus === 'Paid') return ok({ paid: true });
  if (!req.paymentIntentId) return ok({ paid: false, status: 'no_payment_started' });

  try {
    const intent = await gateway.getIntent(req.paymentIntentId);
    if (intent.status === 'succeeded') {
      const info = paymentInfoFromIntent(intent);
      if (info.amountCentavos !== Math.round(req.amount * 100) || info.currency !== 'PHP') {
        await store.recordIssue(`mismatch_${info.paymentId}`, { type: 'amount-mismatch', reference, expected: Math.round(req.amount * 100), got: info.amountCentavos, source: 'check-payment' });
        return ok({ paid: false, status: 'needs_review' });
      }
      await store.markPaid(reference, info);
      return ok({ paid: true });
    }
    return ok({ paid: false, status: intent.status });
  } catch (error) {
    console.error('check-payment failed:', error);
    return fail(502, 'Could not check the payment right now. Please try again in a moment.');
  }
}

// ---------- PayMongo tells us a payment arrived ----------
export async function webhookFlow({ rawBody, signature }, { store, webhookSecret }) {
  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) return fail(401, 'Invalid signature');

  let event;
  try { event = JSON.parse(rawBody); } catch { return fail(400, 'Invalid body'); }
  const attrs = event?.data?.attributes || {};
  if (attrs.type !== 'payment.paid') return ok({ ignored: attrs.type || 'unknown' });

  const payment = attrs.data || {};
  const pa = payment.attributes || {};
  const info = {
    paymentId: payment.id,
    paymentIntentId: pa.payment_intent_id,
    amountCentavos: pa.amount,
    currency: pa.currency,
    livemode: !!attrs.livemode,
  };
  if (!info.paymentId || !info.paymentIntentId) return ok({ ignored: 'incomplete payment data' });

  const req = await store.findRequestByIntent(info.paymentIntentId);
  if (!req) {
    await store.recordIssue(`unmatched_${info.paymentId}`, { type: 'unmatched-payment', ...info });
    return ok({ recorded: 'unmatched' });
  }
  if (info.amountCentavos !== Math.round(req.amount * 100) || info.currency !== 'PHP') {
    await store.recordIssue(`mismatch_${info.paymentId}`, { type: 'amount-mismatch', reference: req.reference, expected: Math.round(req.amount * 100), ...info });
    return ok({ recorded: 'amount-mismatch' });
  }
  if (req.paymentStatus === 'Paid' && req.paymongoPaymentId && req.paymongoPaymentId !== info.paymentId) {
    await store.recordIssue(`duplicate_${info.paymentId}`, { type: 'duplicate-payment', reference: req.reference, ...info });
    return ok({ recorded: 'duplicate' });
  }

  const result = await store.markPaid(req.reference, info);
  return ok({ result });
}

// ---------- daily cleanup of unpaid online requests ----------
export async function cleanupFlow({ now = Date.now }, { store, gateway }) {
  const cutoff = now() - (HOLD_HOURS * 3600 * 1000 + CLEANUP_GRACE_MS);
  const expired = await store.listExpiredAwaiting(cutoff);
  const summary = { checked: expired.length, deleted: 0, markedPaid: 0, errors: 0 };

  for (const req of expired) {
    try {
      if (req.paymentIntentId) {
        const intent = await gateway.getIntent(req.paymentIntentId).catch(() => null);
        if (intent && intent.status === 'succeeded') {
          const info = paymentInfoFromIntent(intent);
          if (info.amountCentavos === Math.round(req.amount * 100) && info.currency === 'PHP') {
            await store.markPaid(req.reference, info);
            summary.markedPaid++;
            continue;
          }
          await store.recordIssue(`mismatch_${info.paymentId}`, { type: 'amount-mismatch', reference: req.reference, source: 'cleanup' });
          continue;   // never delete something that was paid
        }
        if (intent) await gateway.cancelIntent(req.paymentIntentId).catch(() => {});
      }
      await store.deleteBundle(req);
      summary.deleted++;
    } catch (error) {
      console.error('cleanup failed for', req.reference, error);
      summary.errors++;
    }
  }
  return summary;
}
