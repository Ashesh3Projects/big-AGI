import { NextRequest, NextResponse } from 'next/server';

import { getFirebasePrivateProVaultAssetsService } from '~/modules/private-pro/vault/privatePro.vault.assets.firebase';
import { getPrivateProServerConfig } from '~/modules/private-pro/config/privatePro.config.server';
import { env } from '~/server/env.server';


interface PrivateProReservationSweepService {
  sweepExpiredReservations(): Promise<{ released: number }>;
}

export interface PrivateProReservationSweepFactories {
  encrypted(): PrivateProReservationSweepService;
}

export interface PrivateProReservationSweepDependencies {
  encrypted: PrivateProReservationSweepService;
}

export const privateProReservationSweepProductionFactories: PrivateProReservationSweepFactories = {
  encrypted: getFirebasePrivateProVaultAssetsService,
};

export function createPrivateProReservationSweepDependencies(
  factories: PrivateProReservationSweepFactories = privateProReservationSweepProductionFactories,
): PrivateProReservationSweepDependencies {
  return {
    encrypted: factories.encrypted(),
  };
}

export async function sweepExpiredPrivateProReservations(
  dependencies = createPrivateProReservationSweepDependencies(),
): Promise<{ released: number }> {
  return dependencies.encrypted.sweepExpiredReservations();
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

    return NextResponse.json({ error: 'Private Pro legacy endpoint is unavailable.' }, { status: 410 });
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
