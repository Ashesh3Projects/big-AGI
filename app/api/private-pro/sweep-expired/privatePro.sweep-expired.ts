import { NextRequest, NextResponse } from 'next/server';

import { getFirebasePrivateProAssetsService } from '~/modules/private-pro/assets/privatePro.assets.firebase';
import { getFirebasePrivateProVaultAssetsService } from '~/modules/private-pro/vault/privatePro.vault.assets.firebase';
import { getPrivateProServerConfig } from '~/modules/private-pro/config/privatePro.config.server';
import { env } from '~/server/env.server';


interface PrivateProReservationSweepService {
  sweepExpiredReservations(): Promise<{ released: number }>;
}

export interface PrivateProReservationSweepFactories {
  legacy(): PrivateProReservationSweepService;
  encrypted(): PrivateProReservationSweepService;
}

export interface PrivateProReservationSweepDependencies {
  legacy: PrivateProReservationSweepService;
  encrypted: PrivateProReservationSweepService;
}

export const privateProReservationSweepProductionFactories: PrivateProReservationSweepFactories = {
  legacy: getFirebasePrivateProAssetsService,
  encrypted: getFirebasePrivateProVaultAssetsService,
};

export function createPrivateProReservationSweepDependencies(
  factories: PrivateProReservationSweepFactories = privateProReservationSweepProductionFactories,
): PrivateProReservationSweepDependencies {
  return {
    legacy: factories.legacy(),
    encrypted: factories.encrypted(),
  };
}

export async function sweepExpiredPrivateProReservations(
  dependencies = createPrivateProReservationSweepDependencies(),
): Promise<{ released: number }> {
  const [legacy, encrypted] = await Promise.all([
    dependencies.legacy.sweepExpiredReservations(),
    dependencies.encrypted.sweepExpiredReservations(),
  ]);
  return { released: legacy.released + encrypted.released };
}

export function createPrivateProSweepExpiredGET(dependencies: {
  enabled: boolean;
  cronSecret: string | undefined;
  factories: PrivateProReservationSweepFactories;
}) {
  return async function privateProSweepExpiredHandler(request: NextRequest) {
    if (!dependencies.enabled)
      return NextResponse.json({ error: 'Private Pro is disabled.' }, { status: 404 });

    const secret = dependencies.cronSecret;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    return NextResponse.json(await sweepExpiredPrivateProReservations(
      createPrivateProReservationSweepDependencies(dependencies.factories),
    ));
  };
}

export const privateProSweepExpiredProductionDependencies = {
  enabled: getPrivateProServerConfig().enabled,
  cronSecret: env.CRON_SECRET,
  factories: privateProReservationSweepProductionFactories,
};

export const privateProSweepExpiredGET = createPrivateProSweepExpiredGET(
  privateProSweepExpiredProductionDependencies,
);
