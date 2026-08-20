import { TRPCError } from '@trpc/server';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProAdminAuth, getPrivateProFirestore } from '../firebase/firebase.admin';
import { privateProBootstrapProcedure, privateProNodePremiumProcedure } from './privatePro.auth.procedures.server';
import {
  bootstrapPrivateProAccount,
  activatePrivateProAccountRecord,
  PrivateProAccessDeniedError,
  PrivateProResetInProgressError,
  privateProBootstrapErrorCode,
  type PrivateProAccountRecord,
  type PrivateProAuthAdminPort,
} from './privatePro.auth.service';


function createPrivateProAuthAdminPort(): PrivateProAuthAdminPort {
  const auth = getPrivateProAdminAuth();
  const firestore = getPrivateProFirestore();
  return {
    async getWorkspaceResetState() {
      const snapshot = await firestore.doc('privateProOperations/workspaceV1Reset-v1').get();
      if (!snapshot.exists) return 'absent';
      return snapshot.data()?.state === 'complete' ? 'complete' : 'running';
    },
    async activateAccountIfResetIdle(input) {
      const resetReference = firestore.doc('privateProOperations/workspaceV1Reset-v1');
      const accountReference = firestore.doc(`users/${input.uid}`);
      return firestore.runTransaction(async transaction => {
        const resetSnapshot = await transaction.get(resetReference);
        const accountSnapshot = await transaction.get(accountReference);
        if (resetSnapshot.exists && resetSnapshot.data()?.state !== 'complete') throw new PrivateProResetInProgressError();
        const existing = accountSnapshot.exists ? accountSnapshot.data() as PrivateProAccountRecord : null;
        const account = activatePrivateProAccountRecord(existing, input);
        transaction.set(accountReference, account);
        return account;
      });
    },
    async setClaims(uid, claims) {
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, { ...user.customClaims, ...claims });
    },
    async clearClaims(uid) {
      const user = await auth.getUser(uid);
      const claims = { ...user.customClaims };
      delete claims.privatePro;
      delete claims.privateProEpoch;
      await auth.setCustomUserClaims(uid, claims);
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
        nowMs: Date.now(),
      });
    } catch (error) {
      if (privateProBootstrapErrorCode(error) === 'UNAUTHORIZED' && error instanceof PrivateProAccessDeniedError)
        throw new TRPCError({ code: 'UNAUTHORIZED', message: error.message });
      if (privateProBootstrapErrorCode(error) === 'SERVICE_UNAVAILABLE' && error instanceof PrivateProResetInProgressError)
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Private Pro is temporarily unavailable.' });
      throw error;
    }
  }),
  status: privateProNodePremiumProcedure.query(({ ctx }) => ({
    uid: ctx.privateProAccount.uid,
    email: ctx.privateProAccount.email,
    accessEpoch: ctx.privateProAccount.accessEpoch,
  })),
});
