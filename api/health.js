import { getDb } from '../lib/admin.js';
import { json } from '../lib/http.js';

// Open this link in a browser to see whether the setup is complete. It never shows any secret.
export async function GET() {
  const key = process.env.PAYMONGO_SECRET_KEY || '';
  const report = {
    paymongoKey: key.startsWith('sk_test_') ? 'set (TEST mode)' : key.startsWith('sk_live_') ? 'set (LIVE mode)' : key ? 'set, but does not look like a PayMongo secret key' : 'MISSING',
    webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET ? 'set' : 'MISSING',
    cronSecret: process.env.CRON_SECRET ? 'set' : 'MISSING',
    allowedOrigin: process.env.ALLOWED_ORIGIN || 'MISSING',
    firebase: 'not checked',
  };
  try {
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
    await getDb().collection('systemConfig').doc('main').get();
    report.firebase = 'connected';
  } catch (error) {
    report.firebase = process.env.FIREBASE_SERVICE_ACCOUNT ? `could not connect: ${String(error.message).slice(0, 120)}` : 'MISSING';
  }
  return json(200, report);
}
