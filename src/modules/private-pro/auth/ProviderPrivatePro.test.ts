import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createPrivateProAuthBootstrapController } from './ProviderPrivatePro';
import type { PrivateProBootstrap } from './privatePro.auth.service';


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

function bootstrap(uid: string): PrivateProBootstrap {
  return { uid, email: `${uid}@example.com`, accessEpoch: 1 };
}

describe('ProviderPrivatePro auth epochs', () => {
  test('ignores stale account A success after account B becomes current', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<PrivateProBootstrap>>>();
    const applied: string[] = [];
    let currentUser: { uid: string; email: string } | null = null;
    const controller = createPrivateProAuthBootstrapController({
      bootstrap: uid => {
        const request = deferred<PrivateProBootstrap>();
        requests.set(uid, request);
        return request.promise;
      },
      refreshIdToken: async uid => { applied.push(`refresh:${uid}`); },
      firebaseSignOut: async uid => { applied.push(`sign-out:${uid}`); },
      currentUser: () => currentUser,
      setUser: user => { applied.push(`user:${user?.uid ?? 'null'}`); },
      setBootstrap: value => { if (value) applied.push(`bootstrap:${value.uid}`); },
      setState: state => { applied.push(`state:${state}`); },
      setError: () => {}, setDeniedEmail: () => {}, getDeniedEmail: () => undefined,
    });

    currentUser = { uid: 'uid-a', email: 'a@example.com' };
    const a = controller.handleAuthState(currentUser);
    currentUser = { uid: 'uid-b', email: 'b@example.com' };
    const b = controller.handleAuthState(currentUser);
    requests.get('uid-a')!.resolve(bootstrap('uid-a'));
    await a;
    requests.get('uid-b')!.resolve(bootstrap('uid-b'));
    await b;

    assert.equal(applied.includes('bootstrap:uid-a'), false);
    assert.equal(applied.includes('refresh:uid-a'), false);
    assert.equal(applied.includes('bootstrap:uid-b'), true);
    assert.equal(applied.at(-1), 'state:signed-in');
  });

  test('ignores stale account A denial after account B becomes current', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<PrivateProBootstrap>>>();
    const signOuts: string[] = [];
    const bootstraps: string[] = [];
    let currentUser: { uid: string; email: string } | null = null;
    const controller = createPrivateProAuthBootstrapController({
      bootstrap: uid => {
        const request = deferred<PrivateProBootstrap>();
        requests.set(uid, request);
        return request.promise;
      },
      refreshIdToken: async () => {}, firebaseSignOut: async uid => { signOuts.push(uid); }, currentUser: () => currentUser,
      setUser: () => {}, setBootstrap: value => { if (value) bootstraps.push(value.uid); }, setState: () => {}, setError: () => {},
      setDeniedEmail: () => {}, getDeniedEmail: () => undefined,
    });

    currentUser = { uid: 'uid-a', email: 'a@example.com' };
    const a = controller.handleAuthState(currentUser);
    currentUser = { uid: 'uid-b', email: 'b@example.com' };
    const b = controller.handleAuthState(currentUser);
    requests.get('uid-a')!.reject({ data: { code: 'UNAUTHORIZED' } });
    await a;
    requests.get('uid-b')!.resolve(bootstrap('uid-b'));
    await b;

    assert.deepEqual(signOuts, []);
    assert.deepEqual(bootstraps, ['uid-b']);
  });

  test('ignores a pending success after auth becomes signed out or the effect is disposed', async () => {
    const request = deferred<PrivateProBootstrap>();
    const applied: string[] = [];
    let currentUser: { uid: string; email: string } | null = { uid: 'uid-a', email: 'a@example.com' };
    const controller = createPrivateProAuthBootstrapController({
      bootstrap: async () => request.promise, refreshIdToken: async () => { applied.push('refresh'); }, firebaseSignOut: async () => {},
      currentUser: () => currentUser, setUser: () => {}, setBootstrap: value => { if (value) applied.push(value.uid); },
      setState: state => { applied.push(state); }, setError: () => {}, setDeniedEmail: () => {}, getDeniedEmail: () => undefined,
    });
    const pending = controller.handleAuthState(currentUser);
    currentUser = null;
    await controller.handleAuthState(null);
    controller.dispose();
    request.resolve(bootstrap('uid-a'));
    await pending;

    assert.equal(applied.includes('uid-a'), false);
    assert.equal(applied.includes('refresh'), false);
  });

  test('unauthorized bootstrap sign-out rejection becomes a generic current-user error', async () => {
    const states: string[] = [];
    const errors: Array<string | undefined> = [];
    let currentUser: { uid: string; email: string } | null = { uid: 'uid-a', email: 'a@example.com' };
    const controller = createPrivateProAuthBootstrapController({
      bootstrap: async () => { throw { data: { code: 'UNAUTHORIZED' } }; }, refreshIdToken: async () => {},
      firebaseSignOut: async () => { throw new Error('secret sign-out failure'); }, currentUser: () => currentUser,
      setUser: () => {}, setBootstrap: () => {}, setState: state => { states.push(state); }, setError: error => { errors.push(error); },
      setDeniedEmail: () => {}, getDeniedEmail: () => undefined,
    });

    await controller.handleAuthState(currentUser);

    assert.equal(states.at(-1), 'error');
    assert.equal(errors.at(-1), 'Unable to complete Private Pro sign-out.');
  });

  test('ignores stale unauthorized sign-out rejection after account B becomes current', async () => {
    const signOut = deferred<void>();
    const states: string[] = [];
    let currentUser: { uid: string; email: string } | null = { uid: 'uid-a', email: 'a@example.com' };
    let bootstrapCalls = 0;
    const controller = createPrivateProAuthBootstrapController({
      bootstrap: async uid => {
        bootstrapCalls++;
        if (uid === 'uid-a') throw { data: { code: 'UNAUTHORIZED' } };
        return bootstrap(uid);
      },
      refreshIdToken: async () => {}, firebaseSignOut: async () => signOut.promise, currentUser: () => currentUser,
      setUser: () => {}, setBootstrap: () => {}, setState: state => { states.push(state); }, setError: () => {},
      setDeniedEmail: () => {}, getDeniedEmail: () => undefined,
    });
    const a = controller.handleAuthState(currentUser);
    await Promise.resolve();
    currentUser = { uid: 'uid-b', email: 'b@example.com' };
    const b = controller.handleAuthState(currentUser);
    signOut.reject(new Error('stale sign-out failure'));
    await Promise.all([a, b]);

    assert.equal(bootstrapCalls, 2);
    assert.equal(states.at(-1), 'signed-in');
    assert.equal(states.filter(state => state === 'error').length, 0);
  });
});
