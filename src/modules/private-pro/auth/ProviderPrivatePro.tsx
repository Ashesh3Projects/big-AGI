import * as React from 'react';
import type { User } from 'firebase/auth';

import { apiAsyncNode } from '~/common/util/trpc.client';

import { privateProClientConfig, privateProClientConfigComplete } from '../config/privatePro.config';
import {
  privateProOnAuthStateChanged,
  privateProCurrentAuthUser,
  privateProRefreshIdToken,
  privateProSignInWithGoogle,
  privateProSignOut,
} from './privatePro.auth.client';
import { PrivateProAuthScreen } from './PrivateProAuthScreen';
import type { PrivateProBootstrap } from './privatePro.auth.service';


type PrivateProAuthState = 'loading' | 'signed-out' | 'bootstrapping' | 'signed-in' | 'denied' | 'misconfigured' | 'error';

interface PrivateProAuthBootstrapUser {
  uid: string;
  email: string | null;
}

interface PrivateProAuthBootstrapControllerDependencies {
  bootstrap(uid: string): Promise<PrivateProBootstrap>;
  refreshIdToken(uid: string): Promise<void>;
  firebaseSignOut(uid: string): Promise<void>;
  currentUser(): PrivateProAuthBootstrapUser | null;
  setUser(user: PrivateProAuthBootstrapUser | null): void;
  setBootstrap(value: PrivateProBootstrap | null): void;
  setState(state: PrivateProAuthState): void;
  setError(error: string | undefined): void;
  setDeniedEmail(email: string | undefined): void;
  getDeniedEmail(): string | undefined;
}

export function createPrivateProAuthBootstrapController(dependencies: PrivateProAuthBootstrapControllerDependencies) {
  let epoch = 0;
  let disposed = false;
  const current = (capturedEpoch: number, uid: string) => !disposed && epoch === capturedEpoch && dependencies.currentUser()?.uid === uid;
  return {
    async handleAuthState(nextUser: PrivateProAuthBootstrapUser | null): Promise<void> {
      const capturedEpoch = ++epoch;
      dependencies.setUser(nextUser);
      dependencies.setBootstrap(null);
      if (!nextUser) {
        dependencies.setState(dependencies.getDeniedEmail() ? 'denied' : 'signed-out');
        return;
      }
      const uid = nextUser.uid;
      dependencies.setState('bootstrapping');
      try {
        const result = await dependencies.bootstrap(uid);
        if (!current(capturedEpoch, uid)) return;
        await dependencies.refreshIdToken(uid);
        if (!current(capturedEpoch, uid)) return;
        dependencies.setDeniedEmail(undefined);
        dependencies.setBootstrap(result);
        dependencies.setState('signed-in');
      } catch (error) {
        if (!current(capturedEpoch, uid)) return;
        const code = (error as { data?: { code?: string } })?.data?.code;
        if (code === 'UNAUTHORIZED') {
          dependencies.setDeniedEmail(nextUser.email || 'selected account');
          await dependencies.firebaseSignOut(uid);
          return;
        }
        dependencies.setError('Unable to bootstrap Private Pro.');
        dependencies.setState('error');
      }
    },
    dispose(): void {
      disposed = true;
      epoch++;
    },
  };
}

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

    const controller = createPrivateProAuthBootstrapController({
      bootstrap: () => apiAsyncNode.privateProAuth.bootstrap.mutate(),
      refreshIdToken: async uid => {
        if (privateProCurrentAuthUser()?.uid !== uid) return;
        await privateProRefreshIdToken();
      },
      firebaseSignOut: async uid => {
        if (privateProCurrentAuthUser()?.uid !== uid) return;
        await privateProSignOut();
      },
      currentUser: privateProCurrentAuthUser,
      setUser: nextUser => setUser(nextUser as User | null),
      setBootstrap,
      setState,
      setError,
      setDeniedEmail: email => { deniedEmailRef.current = email; },
      getDeniedEmail: () => deniedEmailRef.current,
    });
    const unsubscribe = privateProOnAuthStateChanged(nextUser => { void controller.handleAuthState(nextUser); });
    return () => {
      controller.dispose();
      unsubscribe();
    };
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
