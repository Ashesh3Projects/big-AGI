import { argon2id } from 'hash-wasm';

import type { VaultArgon2idWorkerRequest } from './privatePro.vault.password.worker';


type WorkerTestResponse = {
  protocolVersion: 1;
  kind: 'success';
  keyBytes: Uint8Array<ArrayBuffer>;
} | {
  protocolVersion: 1;
  kind: 'incompatible';
  reason: 'wasm-unavailable' | 'memory-limit';
} | {
  protocolVersion: 1;
  kind: 'failure';
};

type WorkerTestResponder = (request: VaultArgon2idWorkerRequest) => WorkerTestResponse | Promise<WorkerTestResponse>;


export async function realArgon2idWorkerResponse(request: VaultArgon2idWorkerRequest): Promise<WorkerTestResponse> {
  try {
    return {
      protocolVersion: 1,
      kind: 'success',
      keyBytes: Uint8Array.from(await argon2id({
        password: request.passwordBytes,
        salt: request.saltBytes,
        memorySize: request.memoryKiB,
        iterations: request.iterations,
        parallelism: request.parallelism,
        hashLength: 32,
        outputType: 'binary',
      })),
    };
  } finally {
    request.passwordBytes.fill(0);
  }
}

export async function withVaultPasswordWorker<T>(responder: WorkerTestResponder, action: () => Promise<T>): Promise<T> {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

  class TestWorker extends EventTarget {
    postMessage(request: VaultArgon2idWorkerRequest): void {
      void Promise.resolve(responder(request)).then(response => {
        this.dispatchEvent(new MessageEvent('message', { data: response }));
      }).catch(() => {
        this.dispatchEvent(new Event('error'));
      });
    }

    terminate(): void {}
  }

  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  try {
    return await action();
  } finally {
    if (originalWorker)
      Object.defineProperty(globalThis, 'Worker', originalWorker);
    else
      Reflect.deleteProperty(globalThis, 'Worker');
  }
}
