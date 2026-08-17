import { TRPCError } from '@trpc/server';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProAdminAppCheck } from './firebase.admin';


export async function verifyPrivateProAppCheckTokenForConfig(
  token: string | null,
  appCheckEnforced: boolean,
  verifyToken: (token: string) => Promise<unknown>,
): Promise<void> {
  if (!appCheckEnforced) return;
  if (!token)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Firebase App Check token required.' });

  try {
    await verifyToken(token);
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Firebase App Check verification failed.' });
  }
}

export async function verifyPrivateProAppCheckToken(token: string | null): Promise<void> {
  await verifyPrivateProAppCheckTokenForConfig(
    token,
    getPrivateProServerConfig().appCheckEnforced,
    verifiedToken => getPrivateProAdminAppCheck().verifyToken(verifiedToken),
  );
}
