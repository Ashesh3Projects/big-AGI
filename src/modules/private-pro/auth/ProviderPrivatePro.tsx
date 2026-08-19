import * as React from 'react';
import type { User } from 'firebase/auth';

import { apiAsyncNode } from '~/common/util/trpc.client';

import { privateProClientConfig, privateProClientConfigComplete } from '../config/privatePro.config';
import {
  privateProOnAuthStateChanged,
  privateProRefreshIdToken,
  privateProSignInWithGoogle,
  privateProSignOut,
} from './privatePro.auth.client';
import { PrivateProAuthScreen } from './PrivateProAuthScreen';
import type { PrivateProBootstrap } from './privatePro.auth.service';


type PrivateProAuthState = 'loading' | 'signed-out' | 'bootstrapping' | 'signed-in' | 'denied' | 'misconfigured' | 'error';

interface PrivateProAuthContextValue {
  enabled: boolean;
  state: PrivateProAuthState;
  user: User | null;
  bootstrap: PrivateProBootstrap | null;
  signIn: () => Promise<void>;
  firebaseSignOut: () => Promise<void>;
}

const PrivateProAuthContext = React.createContext<PrivateProAuthContextValue | null>(null);

export function ProviderPrivatePro(props: { children: React.ReactNode }) {
  const [state, setState] = React.useState<PrivateProAuthState>(privateProClientConfig.enabled ? 'loading' : 'signed-in');
  const [user, setUser] = React.useState<User | null>(null);
  const [bootstrap, setBootstrap] = React.useState<PrivateProBootstrap | null>(null);
  const [error, setError] = React.useState<string>();
  const deniedEmailRef = React.useRef<string>();

  React.useEffect(() => {
    if (!privateProClientConfig.enabled) return;
    if (!privateProClientConfigComplete()) {
      setError('Set the required NEXT_PUBLIC_FIREBASE_* variables for this deployment.');
      setState('misconfigured');
      return;
    }

    return privateProOnAuthStateChanged((nextUser) => {
      setUser(nextUser);
      setBootstrap(null);
      if (!nextUser) {
        setState(deniedEmailRef.current ? 'denied' : 'signed-out');
        return;
      }

      setState('bootstrapping');
      void apiAsyncNode.privateProAuth.bootstrap.mutate()
        .then(async result => {
          await privateProRefreshIdToken();
          deniedEmailRef.current = undefined;
          setBootstrap(result);
          setState('signed-in');
        })
        .catch(async authError => {
          const code = (authError as { data?: { code?: string } })?.data?.code;
          if (code === 'UNAUTHORIZED') {
            deniedEmailRef.current = nextUser.email || 'selected account';
            await privateProSignOut();
            setState('denied');
            return;
          }
          setError(authError instanceof Error ? authError.message : 'Unable to bootstrap private Pro.');
          setState('error');
        });
    });
  }, []);

  const signIn = React.useCallback(async () => {
    deniedEmailRef.current = undefined;
    setError(undefined);
    setState('loading');
    try {
      await privateProSignInWithGoogle();
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Unable to start Google sign-in.');
      setState('error');
    }
  }, []);

  const value = React.useMemo<PrivateProAuthContextValue>(() => ({
    enabled: privateProClientConfig.enabled,
    state,
    user,
    bootstrap,
    signIn,
    firebaseSignOut: privateProSignOut,
  }), [bootstrap, signIn, state, user]);

  if (state !== 'signed-in')
    return <PrivateProAuthScreen state={state} error={error} deniedEmail={deniedEmailRef.current} onSignIn={() => void signIn()} />;

  return <PrivateProAuthContext.Provider value={value}>{props.children}</PrivateProAuthContext.Provider>;
}

export function usePrivateProAuth(): PrivateProAuthContextValue {
  const value = React.useContext(PrivateProAuthContext);
  if (!value) throw new Error('usePrivateProAuth must be used inside ProviderPrivatePro.');
  return value;
}
