import { TRPCError } from '@trpc/server';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProAdminAuth, getPrivateProFirestore } from '../firebase/firebase.admin';
import { privateProBootstrapProcedure, privateProNodePremiumProcedure } from './privatePro.auth.procedures.server';
import {
  bootstrapPrivateProAccount,
  activatePrivateProAccountRecord,
  PrivateProAccessDeniedError,
  type PrivateProAccountRecord,
  type PrivateProAuthAdminPort,
} from './privatePro.auth.service';


function createPrivateProAuthAdminPort(): PrivateProAuthAdminPort {
  const auth = getPrivateProAdminAuth();
  const firestore = getPrivateProFirestore();
  return {
    async activateAccount(input) {
      const reference = firestore.doc(`users/${input.uid}`);
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        const existing = snapshot.exists ? snapshot.data() as PrivateProAccountRecord : null;
        const account = activatePrivateProAccountRecord(existing, input);
        transaction.set(reference, account);
        return account;
      });
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
    try {
      return await bootstrapPrivateProAccount(ctx.privateProIdentity, createPrivateProAuthAdminPort(), {
        allowedEmails: config.allowedEmails,
        attachmentQuotaBytes: config.attachmentQuotaBytes,
        nowMs: Date.now(),
      });
    } catch (error) {
      if (error instanceof PrivateProAccessDeniedError)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
      throw error;
    }
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
