import { NextRequest, NextResponse } from 'next/server';

import { getFirebasePrivateProAssetsService } from '~/modules/private-pro/assets/privatePro.assets.firebase';
import { getPrivateProServerConfig } from '~/modules/private-pro/config/privatePro.config.server';
import { env } from '~/server/env.server';


export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!getPrivateProServerConfig().enabled)
    return NextResponse.json({ error: 'Private Pro is disabled.' }, { status: 404 });

  const secret = env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  return NextResponse.json(await getFirebasePrivateProAssetsService().sweepExpiredReservations());
}
