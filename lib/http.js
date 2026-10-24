// Dependencies are loaded only when a request arrives (keeps this file testable on its own).
async function defaultDeps() {
  const { getDeps } = await import('./deps.js');
  return getDeps();
}

export function corsHeaders(request) {
  const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// A POST endpoint that takes { reference } and runs one of the flows in core.js
export function referenceEndpoint(flow, depsProvider = defaultDeps) {
  return {
    OPTIONS: (request) => new Response(null, { status: 204, headers: corsHeaders(request) }),
    POST: async (request) => {
      const cors = corsHeaders(request);
      let payload;
      try { payload = await request.json(); } catch { return json(400, { error: 'Invalid request' }, cors); }
      const reference = String(payload?.reference || '').trim().toUpperCase();
      try {
        const result = await flow({ reference }, await depsProvider());
        return json(result.status, result.body, cors);
      } catch (error) {
        console.error('Endpoint error:', error);
        return json(500, { error: 'Something went wrong on the server.' }, cors);
      }
    },
  };
}
