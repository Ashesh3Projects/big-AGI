import { TRPCError } from '@trpc/server';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProAdminAppCheck } from './firebase.admin';


export async function verifyPrivateProAppCheckToken(token: string | null): Promise<void> {
  if (!getPrivateProServerConfig().appCheckEnforced) return;
  if (!token)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Firebase App Check token required.' });

  try {
    await getPrivateProAdminAppCheck().verifyToken(token);
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Firebase App Check verification failed.' });
  }
}
