// Reads and writes the same Firestore database the website uses (with the Firebase Admin key).
// (The Firebase Admin pieces are passed in from lib/admin.js, so this file can be tested on its own.)

const toMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);

function normalize(reference, d) {
  return {
    reference,
    payment: d.payment,
    paymentStatus: d.paymentStatus,
    amount: d.amount,
    slot: d.slot,
    lookupKey: d.lookupKey || null,
    createdAtMs: toMs(d.createdAt),
    paymentIntentId: d.paymentIntentId || null,
    qrCreatedAtMs: toMs(d.qrCreatedAt),
    qrExpiresAtMs: toMs(d.qrExpiresAt),
    paymongoPaymentId: d.paymongoPaymentId || null,
    status: d.status,
    archived: d.archived === true,
    cancelState: (d.cancelRequest && d.cancelRequest.status) || '',
    cancelAttempts: (d.cancelRequest && d.cancelRequest.attempts) || 0,
  };
}

export function createFirestoreStore(db, { FV, TS }) {
  return {
    async getRequest(reference) {
      const snap = await db.collection('requests').doc(reference).get();
      return snap.exists ? normalize(snap.id, snap.data()) : null;
    },

    async findRequestByIntent(intentId) {
      const snap = await db.collection('requests').where('paymentIntentId', '==', intentId).limit(1).get();
      return snap.empty ? null : normalize(snap.docs[0].id, snap.docs[0].data());
    },

    async setPaymentIntent(reference, { paymentIntentId, qrCreatedAtMs, qrExpiresAtMs }) {
      await db.collection('requests').doc(reference).update({
        paymentIntentId,
        qrCreatedAt: TS.fromMillis(qrCreatedAtMs),
        qrExpiresAt: TS.fromMillis(qrExpiresAtMs),
      });
    },

    // One all-or-nothing step: request, public tracking record and an audit record
    async markPaid(reference, info) {
      const requestRef = db.collection('requests').doc(reference);
      const trackingRef = db.collection('tracking').doc(reference);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(requestRef);
        if (!snap.exists) return 'missing';
        if (snap.data().paymentStatus === 'Paid') return 'already-paid';

        tx.update(requestRef, {
          paymentStatus: 'Paid',
          paidAt: FV.serverTimestamp(),
          paymentChannel: 'QR Ph',
          paymongoPaymentId: info.paymentId,
          paymentIntentId: info.paymentIntentId,
          updatedBy: 'PayMongo (automatic)',
          updatedAt: FV.serverTimestamp(),
        });
        tx.set(trackingRef, { paymentStatus: 'Paid', updatedAt: FV.serverTimestamp() }, { merge: true });
        tx.set(db.collection('payments').doc(info.paymentId), {
          reference,
          paymentIntentId: info.paymentIntentId,
          amountCentavos: info.amountCentavos,
          currency: info.currency,
          livemode: !!info.livemode,
          paidAt: FV.serverTimestamp(),
        });
        return 'paid';
      });
    },

    async recordIssue(id, issue) {
      await db.collection('paymentIssues').doc(id).set({ ...issue, recordedAt: FV.serverTimestamp(), resolved: false }, { merge: true });
      try {
        await this.addLog({ action: 'payment-issue', summary: `Payment needs attention (${issue.type || 'issue'}): ${issue.reference ? issue.reference + ' - ' : ''}${id}`, reference: issue.reference || '' });
      } catch (error) { /* the issue itself is already saved */ }
    },

    // The Super Admin's activity log (staff actions are written by the Admin page)
    async addLog({ action, summary, reference }) {
      await db.collection('activityLog').add({
        at: FV.serverTimestamp(), actor: 'System', actorUid: '', actorRole: 'server',
        action, summary: String(summary).slice(0, 300), reference: reference || '', source: 'server',
      });
    },

    // Records the student's cancellation request on the request and on the public tracking record
    async setCancelRequest(reference, { reason }) {
      const requestRef = db.collection('requests').doc(reference);
      const trackingRef = db.collection('tracking').doc(reference);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(requestRef);
        if (!snap.exists) return 'gone';
        const d = snap.data();
        if (d.archived === true || d.status !== 'Pending') return 'gone';
        const current = d.cancelRequest || {};
        if (current.status === 'Requested') return 'already-requested';
        tx.update(requestRef, {
          cancelRequest: { status: 'Requested', reason, requestedAt: FV.serverTimestamp(), attempts: (current.attempts || 0) + 1 },
          updatedAt: FV.serverTimestamp(),
        });
        tx.set(trackingRef, { cancelState: 'Requested', cancelNote: '', updatedAt: FV.serverTimestamp() }, { merge: true });
        return 'ok';
      });
    },

    async listExpiredAwaiting(cutoffMs) {
      const snap = await db.collection('requests').where('paymentStatus', '==', 'Awaiting Payment').get();
      return snap.docs.map((d) => normalize(d.id, d.data()))
        .filter((r) => r.payment === 'Online' && r.createdAtMs && r.createdAtMs < cutoffMs);
    },

    async deleteBundle(req) {
      const batch = db.batch();
      batch.delete(db.collection('requests').doc(req.reference));
      batch.delete(db.collection('tracking').doc(req.reference));
      if (req.lookupKey) batch.delete(db.collection('lookup').doc(req.lookupKey).collection('refs').doc(req.reference));
      if (req.slot) batch.set(db.collection('slots').doc(req.slot), { count: FV.increment(-1) }, { merge: true });
      await batch.commit();
    },
  };
}
