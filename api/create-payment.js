import { createPaymentFlow } from '../lib/core.js';
import { referenceEndpoint } from '../lib/http.js';

export const { OPTIONS, POST } = referenceEndpoint(createPaymentFlow);
