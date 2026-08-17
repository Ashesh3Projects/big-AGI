import { argon2id } from 'hash-wasm';


export interface VaultArgon2idWorkerRequest {
  passwordBytes: Uint8Array<ArrayBuffer>;
  saltBytes: Uint8Array<ArrayBuffer>;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

type VaultArgon2idWorkerResponse = {
  kind: 'success';
  keyBytes: Uint8Array;
} | {
  kind: 'incompatible' | 'failure';
};


function isSupportedIncompatibility(error: unknown): boolean {
  if (typeof WebAssembly === 'undefined' || error instanceof RangeError)
    return true;
  return error instanceof Error && /(?:webassembly|wasm|memory|allocation|out of bounds)/i.test(error.message);
}

export async function deriveArgon2idBytesInWorker(request: VaultArgon2idWorkerRequest): Promise<Uint8Array<ArrayBuffer>> {
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
    const response: VaultArgon2idWorkerResponse = { kind: 'success', keyBytes };
    workerScope.postMessage(response, [keyBytes.buffer]);
  }).catch(error => {
    const response: VaultArgon2idWorkerResponse = { kind: isSupportedIncompatibility(error) ? 'incompatible' : 'failure' };
    workerScope.postMessage(response);
  });
});
