/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import * as z from 'zod/v4';
import { initTRPC, TRPCError } from '@trpc/server';
import { transformer } from './trpc.transformer';
import { TRPCFetcherError } from './trpc.router.fetchers';

import { getPrivateProServerConfig } from '~/modules/private-pro/config/privatePro.config.server';
import { privateProIdentityCanAccessDeployment, privateProIdentityHasPremiumAccess } from '~/modules/private-pro/auth/privatePro.auth.types';
import { extractFirebaseBearerToken, verifyFirebaseIdToken } from '~/modules/private-pro/firebase/firebase.token';


/**
 * Type of the Context object passed to procedures/resolvers, to avoid circular dependencies.
 */
export type ChatGenerateContentContext = Awaited<ReturnType<typeof createTRPCFetchContext>>;


/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 */
export const createTRPCFetchContext = async ({ req }: FetchCreateContextFnOptions) => {
  const privateProConfig = getPrivateProServerConfig();
  const privateProToken = extractFirebaseBearerToken(req.headers.get('authorization'));
  let privateProIdentity = null;
  let privateProAuthError: Error | null = null;
  if (privateProToken) {
    try {
      privateProIdentity = await verifyFirebaseIdToken(privateProToken, {
        projectId: privateProConfig.firebase.projectId,
      });
    } catch (error) {
      privateProAuthError = error instanceof Error ? error : new Error('Firebase identity verification failed.');
    }
  }

  return {
    // only used by Backend Analytics
    hostName: req.headers?.get('host') ?? 'localhost',
    // enables cancelling upstream requests when the downstream request is aborted
    reqSignal: req.signal,
    privateProIdentity,
    privateProAuthError,
    privateProAppCheckToken: req.headers.get('x-firebase-appcheck'),
  };
};


/**
 * 2. SERVER-SIDE INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCFetchContext>().create({
  // server transformer - serialize: -> client, deserialize: <- client
  transformer: transformer,
  errorFormatter({ shape, error }) {

    // Important: remove the 'stack' from the error data to avoid leaking internals and shorten the payload
    const { stack, ...nonStackData } = shape.data;

    // Enable client-side decisions: communicate fetcher/network error details downstream
    const fetcherError = error instanceof TRPCFetcherError ? {
      aixFCategory: error.category,
      aixFHttpStatus: error.httpStatus ?? null,
      aixFNetError: error.connErrorName ?? null,
    } : {};

    return {
      ...shape,
      data: {
        ...nonStackData,
        ...fetcherError,
        zodError:
          error.cause instanceof z.ZodError ? z.treeifyError(error.cause) : null,
      },
    };
  },
});

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @link https://trpc.io/docs/v11/router
 */
export const createTRPCRouter = t.router;

/**
 * Public (unprotected) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 *
 * @link https://trpc.io/docs/v11/procedures
 */
const requireDeploymentAccess = t.middleware(({ ctx, next }) => {
  const config = getPrivateProServerConfig();
  if (!privateProIdentityCanAccessDeployment(config.enabled, ctx.privateProIdentity, config.allowedEmails))
    throw new TRPCError({ code: 'UNAUTHORIZED', message: ctx.privateProAuthError?.message ?? 'Authentication required.' });
  return next();
});

export const publicProcedure = t.procedure.use(requireDeploymentAccess);

/**
 * Edge procedures for the AI inference Edge network:
 * - AIX streaming endpoints
 * - specific endpoints: Anthropic, Gemini, Ollama, OpenAI
 *
 * Open for now, as these are pass-through with service keys inside the request usually.
 * May be closed in the future if key material is on the server-side procedure, in which case
 * authentication will be required.
 */
export const edgeProcedure = t.procedure.use(requireDeploymentAccess);


/**
 * Authenticated users only. - FORWARD-LOOKING
 */
const requireAuthed = t.middleware(({ ctx, next }) => {
  const config = getPrivateProServerConfig();
  if (!ctx.privateProIdentity || !privateProIdentityCanAccessDeployment(true, ctx.privateProIdentity, config.allowedEmails))
    throw new TRPCError({ code: 'UNAUTHORIZED', message: ctx.privateProAuthError?.message ?? 'Authentication required.' });
  return next({
    ctx: {
      ...ctx,
      privateProIdentity: ctx.privateProIdentity,
    },
  });
});

export const authedProcedure = t.procedure.use(requireAuthed);

/**
 * Premium procedure - FORWARD-LOOKING
 */
const requirePremium = requireAuthed.unstable_pipe(({ ctx, next }) => {
  if (!privateProIdentityHasPremiumAccess(ctx.privateProIdentity))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro entitlement required.' });
  return next({
    ctx: {
      ...ctx,
      privateProIdentity: ctx.privateProIdentity,
    },
  });
});

export const premiumProcedure = t.procedure.use(requirePremium);

/**
 * User-feature-gated procedure - FORWARD-LOOKING
 */
export const authGatedProcedure = authedProcedure;

/**
 * Tenant Admin procedure - FORWARD-LOOKING
 */
export const tenantAdminProcedure = premiumProcedure;


// /**
//  * Create a server-side caller
//  * @link https://trpc.io/docs/v11/server/server-side-calls
//  */
// export const createCallerFactory = t.createCallerFactory;
