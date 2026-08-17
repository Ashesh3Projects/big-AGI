import { argon2id } from 'hash-wasm';


export interface VaultArgon2idWorkerRequest {
  passwordBytes: Uint8Array<ArrayBuffer>;
  saltBytes: Uint8Array<ArrayBuffer>;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

type VaultArgon2idWorkerResponse = {
  protocolVersion: 1;
  kind: 'success';
  keyBytes: Uint8Array;
} | {
  protocolVersion: 1;
  kind: 'incompatible';
  reason: 'wasm-unavailable' | 'memory-limit';
} | {
  protocolVersion: 1;
  kind: 'failure';
};


function supportedIncompatibilityReason(error: unknown): 'wasm-unavailable' | 'memory-limit' | null {
  if (typeof WebAssembly === 'undefined')
    return 'wasm-unavailable';
  if (error instanceof RangeError || error instanceof Error && /(?:memory|allocation|out of bounds)/i.test(error.message))
    return 'memory-limit';
  if (error instanceof Error && /(?:webassembly|wasm)/i.test(error.message))
    return 'wasm-unavailable';
  return null;
}

async function deriveArgon2idBytesInWorker(request: VaultArgon2idWorkerRequest): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const result = await argon2id({
      password: request.passwordBytes,
      salt: request.saltBytes,
      memorySize: request.memoryKiB,
      iterations: request.iterations,
      parallelism: request.parallelism,
      hashLength: 32,
      outputType: 'binary',
    });
    return Uint8Array.from(result);
  } finally {
    request.passwordBytes.fill(0);
  }
}

interface VaultWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<VaultArgon2idWorkerRequest>) => void): void;
  postMessage(message: VaultArgon2idWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = typeof self === 'undefined' ? null : self as unknown as VaultWorkerScope;

workerScope?.addEventListener('message', event => {
  const request = event.data as VaultArgon2idWorkerRequest;
  void deriveArgon2idBytesInWorker(request).then(keyBytes => {
    const response: VaultArgon2idWorkerResponse = { protocolVersion: 1, kind: 'success', keyBytes };
    workerScope.postMessage(response, [keyBytes.buffer]);
  }).catch(error => {
    const incompatibilityReason = supportedIncompatibilityReason(error);
    const response: VaultArgon2idWorkerResponse = incompatibilityReason
      ? { protocolVersion: 1, kind: 'incompatible', reason: incompatibilityReason }
      : { protocolVersion: 1, kind: 'failure' };
    workerScope.postMessage(response);
  });
});
