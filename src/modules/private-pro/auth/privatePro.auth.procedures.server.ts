import { TRPCError } from '@trpc/server';

import { authedProcedure, premiumProcedure } from '~/server/trpc/trpc.server';

import { getPrivateProFirestore } from '../firebase/firebase.admin';
import { verifyPrivateProAppCheckToken } from '../firebase/firebase.appcheck.server';
import { privateProAccountIsCurrent, type PrivateProAccountRecord } from './privatePro.auth.service';
import type { PrivateProVaultDeviceMetadata, PrivateProVaultKeyset } from '../vault/privatePro.vault.types';


export const privateProBootstrapProcedure = authedProcedure.use(async ({ ctx, next }) => {
  await verifyPrivateProAppCheckToken(ctx.privateProAppCheckToken);
  return next();
});

export interface PrivateProPremiumProcedureDependencies {
  verifyAppCheckToken(token: string | null): Promise<void>;
  getAccount(uid: string): Promise<PrivateProAccountRecord | null>;
}

export interface PrivateProVaultProcedureDependencies {
  getVaultAccess(uid: string, deviceId: string): Promise<{
    device: PrivateProVaultDeviceMetadata | null;
    keyset: PrivateProVaultKeyset | null;
  }>;
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

async function requirePrivateProVaultDevice(
  ctx: {
    privateProIdentity: { uid: string };
    privateProDeviceId: string | null;
  },
  dependencies: PrivateProVaultProcedureDependencies,
) {
    const deviceId = ctx.privateProDeviceId;
    if (!deviceId || !/^[A-Za-z0-9_-]{43}$/.test(deviceId))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro vault device is not authorized.' });
    let access: Awaited<ReturnType<PrivateProVaultProcedureDependencies['getVaultAccess']>>;
    try {
      access = await dependencies.getVaultAccess(ctx.privateProIdentity.uid, deviceId);
    } catch {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Private Pro authorization failed.' });
    }
    if (!access.device || access.device.revokedAtMs !== null || !access.keyset || access.device.keyVersion !== access.keyset.keyVersion)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro vault device is not authorized.' });
    return { device: access.device, keyset: access.keyset };
}

export function createPrivateProVaultProcedure(
  procedure: typeof privateProNodePremiumProcedure,
  dependencies: PrivateProVaultProcedureDependencies,
) {
  return procedure.use(async ({ ctx, next }) => {
    const access = await requirePrivateProVaultDevice(ctx, dependencies);
    return next({ ctx: { ...ctx, privateProVaultDevice: access.device, privateProVaultKeyset: access.keyset } });
  });
}

export function createPrivateProVaultPutKeysetProcedure(
  procedure: typeof privateProNodePremiumProcedure,
  dependencies: PrivateProVaultProcedureDependencies,
) {
  return procedure.use(async ({ ctx, getRawInput, next }) => {
    const input = await getRawInput() as { baseWrappingVersion?: unknown };
    if (input?.baseWrappingVersion === 0) return next();
    const access = await requirePrivateProVaultDevice(ctx, dependencies);
    return next({ ctx: { ...ctx, privateProVaultDevice: access.device, privateProVaultKeyset: access.keyset } });
  });
}
