// Talks to PayMongo. Docs: QR Ph API (create intent -> create qrph method -> attach -> read QR image)
const API = 'https://api.paymongo.com/v1';

export function createPaymongoGateway(secretKey, fetchImpl = globalThis.fetch) {
  const auth = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

  async function call(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const error = new Error(json?.errors?.[0]?.detail || `PayMongo error ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return json;
  }

  const normalizeIntent = (json) => {
    const d = json.data;
    const a = d.attributes || {};
    return {
      id: d.id,
      clientKey: a.client_key,
      status: a.status,
      amount: a.amount,
      currency: a.currency,
      livemode: !!a.livemode,
      imageUrl: a.next_action?.code?.image_url || null,
      payments: (a.payments || []).map((p) => ({ id: p.id, amount: p.attributes?.amount, currency: p.attributes?.currency })),
    };
  };

  return {
    async createIntent({ amountCentavos, description, reference }) {
      return normalizeIntent(await call('POST', '/payment_intents', {
        data: { attributes: { amount: amountCentavos, currency: 'PHP', payment_method_allowed: ['qrph'], description, metadata: { reference } } },
      }));
    },
    async createQrMethod({ expirySeconds }) {
      const json = await call('POST', '/payment_methods', { data: { attributes: { type: 'qrph', expiry_seconds: expirySeconds } } });
      return { id: json.data.id };
    },
    async attach({ intentId, methodId, clientKey }) {
      return normalizeIntent(await call('POST', `/payment_intents/${intentId}/attach`, {
        data: { attributes: { payment_method: methodId, client_key: clientKey } },
      }));
    },
    async getIntent(id) {
      return normalizeIntent(await call('GET', `/payment_intents/${id}`));
    },
    async cancelIntent(id) {
      await call('POST', `/payment_intents/${id}/cancel`);
    },
  };
}
