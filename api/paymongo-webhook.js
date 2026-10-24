import { webhookFlow } from '../lib/core.js';
import { getDeps } from '../lib/deps.js';
import { json } from '../lib/http.js';

// The raw text of the request is needed to check PayMongo's signature
export async function POST(request) {
  const rawBody = await request.text();
  try {
    const result = await webhookFlow({ rawBody, signature: request.headers.get('paymongo-signature') }, getDeps());
    return json(result.status, result.body);
  } catch (error) {
    console.error('Webhook error:', error);
    return json(500, { error: 'Webhook failed' });   // PayMongo will retry
  }
}
