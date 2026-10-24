import { createFirestoreStore } from './firestore.js';
import { createPaymongoGateway } from './paymongo.js';
import { getDb, FieldValue, Timestamp } from './admin.js';

let cached = null;
export function getDeps() {
  if (!cached) {
    cached = {
      store: createFirestoreStore(getDb(), { FV: FieldValue, TS: Timestamp }),
      gateway: createPaymongoGateway(process.env.PAYMONGO_SECRET_KEY),
      webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET,
    };
  }
  return cached;
}
