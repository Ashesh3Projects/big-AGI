import type { Firestore, Transaction } from 'firebase-admin/firestore';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getPrivateProFirestore, getPrivateProStorageBucket } from '../firebase/firebase.admin';
import { PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES } from './privatePro.vault.assets.crypto';
import {
  createPrivateProVaultAssetsService,
  type PrivateProVaultAssetAccount,
  type PrivateProVaultAssetPort,
  type PrivateProVaultAssetRateWindow,
  type PrivateProVaultAssetRecord,
  type PrivateProVaultAssetReservation,
  type PrivateProVaultAssetTransaction,
} from './privatePro.vault.assets.service';


function vaultRoot(uid: string): string {
  return `users/${uid}/vault/data`;
}

class FirebasePrivateProVaultAssetTransaction implements PrivateProVaultAssetTransaction {
  constructor(
    private readonly db: Firestore,
    private readonly transaction: Transaction,
    private readonly uid: string,
  ) {}

  async getAccount() {
    const snapshot = await this.transaction.get(this.db.doc(`users/${this.uid}`));
    if (!snapshot.exists) throw new Error('Private Pro account was not found.');
    return snapshot.data() as PrivateProVaultAssetAccount;
  }

  async saveAccount(account: PrivateProVaultAssetAccount) {
    this.transaction.set(this.db.doc(`users/${this.uid}`), account, { merge: true });
  }

  async getReservation(operationId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/assetReservations/${operationId}`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultAssetReservation : null;
  }

  async getActiveReservationForAsset(opaqueAssetId: string) {
    const query = this.db.collection(`${vaultRoot(this.uid)}/assetReservations`)
      .where('opaqueAssetId', '==', opaqueAssetId)
      .where('status', '==', 'reserved')
      .limit(1);
    const snapshot = await this.transaction.get(query);
    return snapshot.empty ? null : snapshot.docs[0].data() as PrivateProVaultAssetReservation;
  }

  async saveReservation(reservation: PrivateProVaultAssetReservation) {
    this.transaction.set(this.db.doc(`${vaultRoot(this.uid)}/assetReservations/${reservation.operationId}`), reservation);
  }

  async getAsset(opaqueAssetId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/assets/${opaqueAssetId}`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultAssetRecord : null;
  }

  async saveAsset(asset: PrivateProVaultAssetRecord) {
    this.transaction.set(this.db.doc(`${vaultRoot(this.uid)}/assets/${asset.opaqueAssetId}`), asset);
  }

  async getRateWindow(windowId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/assetRateWindows/${windowId}`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultAssetRateWindow : null;
  }

  async saveRateWindow(window: PrivateProVaultAssetRateWindow) {
    this.transaction.set(this.db.doc(`${vaultRoot(this.uid)}/assetRateWindows/${window.windowId}`), window);
  }
}

export class FirebasePrivateProVaultAssetPort implements PrivateProVaultAssetPort {
  constructor(
    private readonly db: Firestore = getPrivateProFirestore(),
    private readonly bucket = getPrivateProStorageBucket(),
  ) {}

  transaction<T>(uid: string, callback: (transaction: PrivateProVaultAssetTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(transaction => callback(new FirebasePrivateProVaultAssetTransaction(this.db, transaction, uid)));
  }

  async listExpiredReservations(atMs: number, limit: number) {
    const snapshot = await this.db.collectionGroup('assetReservations')
      .where('status', '==', 'reserved')
      .where('expiresAtMs', '<=', atMs)
      .limit(limit)
      .get();
    return snapshot.docs.flatMap(document => {
      const uid = document.ref.parent.parent?.parent.parent?.id;
      return uid ? [{ uid, operationId: document.id }] : [];
    });
  }

  async createSignedUpload(objectPath: string, objectSha256: string, objectBytes: number) {
    const requiredHeaders = {
      'content-type': 'application/octet-stream',
      'x-goog-meta-sha256': objectSha256,
    };
    const [uploadUrl] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType: 'application/octet-stream',
      extensionHeaders: { 'x-goog-meta-sha256': objectSha256 },
    });
    return { uploadUrl, requiredHeaders };
  }

  async createSignedDownload(objectPath: string) {
    const [downloadUrl] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
    });
    return downloadUrl;
  }

  async getObjectMetadata(objectPath: string) {
    const [metadata] = await this.bucket.file(objectPath).getMetadata();
    const objectSha256 = metadata.metadata?.sha256;
    return {
      objectPath,
      byteSize: Number(metadata.size),
      contentType: metadata.contentType ?? '',
      objectSha256: typeof objectSha256 === 'string' ? objectSha256 : '',
    };
  }

  async deleteObject(objectPath: string) {
    await this.bucket.file(objectPath).delete({ ignoreNotFound: true });
  }
}

let firebasePrivateProVaultAssetsService: ReturnType<typeof createPrivateProVaultAssetsService> | undefined;

export function getFirebasePrivateProVaultAssetsService() {
  if (!firebasePrivateProVaultAssetsService) {
    const config = getPrivateProServerConfig();
    firebasePrivateProVaultAssetsService = createPrivateProVaultAssetsService(new FirebasePrivateProVaultAssetPort(), {
      maxAssetCiphertextBytes: config.maxFileBytes + PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES + 1024,
      rateLimit: config.uploadRateLimit,
    });
  }
  return firebasePrivateProVaultAssetsService;
}
