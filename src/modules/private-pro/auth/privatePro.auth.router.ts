import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProAdminAuth, getPrivateProFirestore } from '../firebase/firebase.admin';
import { privateProBootstrapProcedure, privateProNodePremiumProcedure } from './privatePro.auth.procedures.server';
import {
  bootstrapPrivateProAccount,
  type PrivateProAccountRecord,
  type PrivateProAuthAdminPort,
} from './privatePro.auth.service';


function createPrivateProAuthAdminPort(): PrivateProAuthAdminPort {
  const auth = getPrivateProAdminAuth();
  const firestore = getPrivateProFirestore();
  return {
    async getAccount(uid) {
      const snapshot = await firestore.doc(`users/${uid}`).get();
      return snapshot.exists ? snapshot.data() as PrivateProAccountRecord : null;
    },
    async saveAccount(record) {
      await firestore.doc(`users/${record.uid}`).set(record);
    },
    async setClaims(uid, claims) {
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, { ...user.customClaims, ...claims });
    },
    async revokeRefreshTokens(uid) {
      await auth.revokeRefreshTokens(uid);
    },
  };
}

export const privateProAuthRouter = createTRPCRouter({
  bootstrap: privateProBootstrapProcedure.mutation(async ({ ctx }) => {
    const config = getPrivateProServerConfig();
    return bootstrapPrivateProAccount(ctx.privateProIdentity, createPrivateProAuthAdminPort(), {
      allowedEmails: config.allowedEmails,
      attachmentQuotaBytes: config.attachmentQuotaBytes,
      nowMs: Date.now(),
    });
  }),
  status: privateProNodePremiumProcedure.query(({ ctx }) => ({
    uid: ctx.privateProAccount.uid,
    email: ctx.privateProAccount.email,
    accessEpoch: ctx.privateProAccount.accessEpoch,
    quotaBytes: ctx.privateProAccount.quotaBytes,
    usedBytes: ctx.privateProAccount.usedBytes,
    reservedBytes: ctx.privateProAccount.reservedBytes,
  })),
});
