import { createTRPCRouter } from './trpc.server';

import { browseRouter } from '~/modules/browse/browse.router';
import { tradeRouter } from '~/modules/trade/server/trade.router';
import { privateProAuthRouter } from '~/modules/private-pro/auth/privatePro.auth.router';
import { privateProSyncRouter } from '~/modules/private-pro/sync/privatePro.sync.router';

/**
 * Cloud rooter, which is geolocated in 1 location and separate from the other routers.
 * NOTE: at the time of writing, the location is aws|us-east-1
 */
export const appRouterCloud = createTRPCRouter({
  browse: browseRouter,
  privateProAuth: privateProAuthRouter,
  privateProSync: privateProSyncRouter,
  trade: tradeRouter,
});

// export type definition of API
export type AppRouterCloud = typeof appRouterCloud;
