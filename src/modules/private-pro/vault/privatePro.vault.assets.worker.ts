import { encryptPrivateProVaultAssetChunk, type PrivateProVaultAssetChunk, type PrivateProVaultAssetChunkAADInput } from './privatePro.vault.assets.crypto';


type PrivateProVaultAssetWorkerRequest = {
  protocolVersion: 1;
  kind: 'sha256';
  bytes: Uint8Array<ArrayBuffer>;
} | {
  protocolVersion: 1;
  kind: 'encrypt';
  key: CryptoKey;
  aad: PrivateProVaultAssetChunkAADInput;
  plaintext: Uint8Array<ArrayBuffer>;
};

type PrivateProVaultAssetWorkerResponse = {
  protocolVersion: 1;
  kind: 'sha256';
  digestHex: string;
} | {
  protocolVersion: 1;
  kind: 'encrypt';
  chunk: PrivateProVaultAssetChunk;
} | {
  protocolVersion: 1;
  kind: 'failure';
};

interface VaultAssetWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<PrivateProVaultAssetWorkerRequest>) => void): void;
  postMessage(message: PrivateProVaultAssetWorkerResponse): void;
}


async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

const workerScope = typeof self === 'undefined' ? null : self as unknown as VaultAssetWorkerScope;

workerScope?.addEventListener('message', event => {
  const request = event.data;
  if (request?.protocolVersion !== 1) {
    workerScope.postMessage({ protocolVersion: 1, kind: 'failure' });
    return;
  }
  if (request.kind === 'encrypt' && request.plaintext instanceof Uint8Array) {
    void encryptPrivateProVaultAssetChunk(request.key, request.aad, request.plaintext).then(chunk => {
      request.plaintext.fill(0);
      workerScope.postMessage({ protocolVersion: 1, kind: 'encrypt', chunk });
    }).catch(() => workerScope.postMessage({ protocolVersion: 1, kind: 'failure' }));
    return;
  }
  if (request.kind === 'sha256' && request.bytes instanceof Uint8Array) {
    void sha256Hex(request.bytes).then(digestHex => {
      request.bytes.fill(0);
      workerScope.postMessage({ protocolVersion: 1, kind: 'sha256', digestHex });
    }).catch(() => workerScope.postMessage({ protocolVersion: 1, kind: 'failure' }));
    return;
  }
  workerScope.postMessage({ protocolVersion: 1, kind: 'failure' });
});
