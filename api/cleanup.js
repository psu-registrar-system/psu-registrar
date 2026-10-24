import { cleanupFlow, isCronAuthorized } from '../lib/core.js';
import { getDeps } from '../lib/deps.js';
import { json } from '../lib/http.js';

// Runs once a day (see vercel.json). Vercel sends the CRON_SECRET automatically.
export async function GET(request) {
  if (!isCronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return json(401, { error: 'Unauthorized' });
  }
  try {
    return json(200, await cleanupFlow({}, getDeps()));
  } catch (error) {
    console.error('Cleanup error:', error);
    return json(500, { error: 'Cleanup failed' });
  }
}
