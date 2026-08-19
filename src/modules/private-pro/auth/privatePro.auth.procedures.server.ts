import { TRPCError } from '@trpc/server';

import { authedProcedure, premiumProcedure } from '~/server/trpc/trpc.server';

import { getPrivateProFirestore } from '../firebase/firebase.admin';
import { verifyPrivateProAppCheckToken } from '../firebase/firebase.appcheck.server';
import { privateProAccountIsCurrent, type PrivateProAccountRecord } from './privatePro.auth.service';


export const privateProBootstrapProcedure = authedProcedure.use(async ({ ctx, next }) => {
  await verifyPrivateProAppCheckToken(ctx.privateProAppCheckToken);
  return next();
});

export interface PrivateProPremiumProcedureDependencies {
  verifyAppCheckToken(token: string | null): Promise<void>;
  getAccount(uid: string): Promise<PrivateProAccountRecord | null>;
}

const privateProPremiumProcedureDependencies: PrivateProPremiumProcedureDependencies = {
  verifyAppCheckToken: verifyPrivateProAppCheckToken,
  async getAccount(uid) {
    const snapshot = await getPrivateProFirestore().doc(`users/${uid}`).get();
    return snapshot.exists ? snapshot.data() as PrivateProAccountRecord : null;
  },
};

export function createPrivateProNodePremiumProcedure(
  dependencies: PrivateProPremiumProcedureDependencies = privateProPremiumProcedureDependencies,
) {
  return premiumProcedure
  .use(async ({ ctx, next }) => {
    await dependencies.verifyAppCheckToken(ctx.privateProAppCheckToken);
    return next();
  })
  .use(async ({ ctx, next }) => {
    let account: PrivateProAccountRecord | null;
    try {
      account = await dependencies.getAccount(ctx.privateProIdentity.uid);
    } catch {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Private Pro authorization failed.' });
    }
    if (!privateProAccountIsCurrent(ctx.privateProIdentity, account))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro account is inactive or stale.' });
    return next({ ctx: { ...ctx, privateProAccount: account } });
  });
}

export const privateProNodePremiumProcedure = createPrivateProNodePremiumProcedure();
