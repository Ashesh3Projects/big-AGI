import { TRPCError } from '@trpc/server';

import { authedProcedure, premiumProcedure } from '~/server/trpc/trpc.server';

import { getPrivateProFirestore } from '../firebase/firebase.admin';
import { verifyPrivateProAppCheckToken } from '../firebase/firebase.appcheck.server';
import { privateProAccountIsCurrent, type PrivateProAccountRecord } from './privatePro.auth.service';


export const privateProBootstrapProcedure = authedProcedure.use(async ({ ctx, next }) => {
  await verifyPrivateProAppCheckToken(ctx.privateProAppCheckToken);
  return next();
});

export const privateProNodePremiumProcedure = premiumProcedure
  .use(async ({ ctx, next }) => {
    await verifyPrivateProAppCheckToken(ctx.privateProAppCheckToken);
    return next();
  })
  .use(async ({ ctx, next }) => {
    const snapshot = await getPrivateProFirestore().doc(`users/${ctx.privateProIdentity.uid}`).get();
    const account = snapshot.exists ? snapshot.data() as PrivateProAccountRecord : null;
    if (!privateProAccountIsCurrent(ctx.privateProIdentity, account))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro account is inactive or stale.' });
    return next({ ctx: { ...ctx, privateProAccount: account } });
  });
