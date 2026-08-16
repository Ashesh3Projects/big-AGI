import type { Firestore, Transaction } from 'firebase-admin/firestore';

import { getPrivateProFirestore, getPrivateProStorageBucket } from '../firebase/firebase.admin';
import type {
  PrivateProAssetAccount,
  PrivateProAssetRecord,
  PrivateProAssetRateWindow,
  PrivateProAssetReservation,
} from './privatePro.assets.types';
import type { PrivateProAssetsPort, PrivateProAssetsTransaction } from './privatePro.assets.service';
import { createPrivateProAssetsService } from './privatePro.assets.service';


class FirebaseAssetsTransaction implements PrivateProAssetsTransaction {
  constructor(
    private readonly db: Firestore,
    private readonly transaction: Transaction,
    private readonly uid: string,
  ) {}

  async getAccount() {
    const snapshot = await this.transaction.get(this.db.doc(`users/${this.uid}`));
    if (!snapshot.exists) throw new Error('Private Pro account was not found.');
    return snapshot.data() as PrivateProAssetAccount;
  }

  async saveAccount(account: PrivateProAssetAccount) {
    this.transaction.set(this.db.doc(`users/${this.uid}`), account, { merge: true });
  }

  async getReservation(operationId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`users/${this.uid}/quotaReservations/${operationId}`));
    return snapshot.exists ? snapshot.data() as PrivateProAssetReservation : null;
  }

  async saveReservation(reservation: PrivateProAssetReservation) {
    this.transaction.set(this.db.doc(`users/${this.uid}/quotaReservations/${reservation.operationId}`), reservation);
  }

  async getAsset(assetId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`users/${this.uid}/assets/${assetId}`));
    return snapshot.exists ? snapshot.data() as PrivateProAssetRecord : null;
  }

  async findAssetByHash(contentHash: string) {
    const query = this.db.collection(`users/${this.uid}/assets`)
      .where('contentHash', '==', contentHash)
      .where('status', '==', 'ready')
      .limit(1);
    const snapshot = await this.transaction.get(query);
    return snapshot.empty ? null : snapshot.docs[0].data() as PrivateProAssetRecord;
  }

  async saveAsset(asset: PrivateProAssetRecord) {
    this.transaction.set(this.db.doc(`users/${this.uid}/assets/${asset.assetId}`), asset);
  }

  async getRateWindow(windowId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`users/${this.uid}/uploadRateWindows/${windowId}`));
    return snapshot.exists ? snapshot.data() as PrivateProAssetRateWindow : null;
  }

  async saveRateWindow(window: PrivateProAssetRateWindow) {
    this.transaction.set(this.db.doc(`users/${this.uid}/uploadRateWindows/${window.windowId}`), window);
  }
}

export class FirebasePrivateProAssetsPort implements PrivateProAssetsPort {
  private readonly db = getPrivateProFirestore();
  private readonly bucket = getPrivateProStorageBucket();

  transaction<T>(uid: string, callback: (transaction: PrivateProAssetsTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(transaction => callback(new FirebaseAssetsTransaction(this.db, transaction, uid)));
  }

  async listExpiredReservations(atMs: number, limit: number) {
    const snapshot = await this.db.collectionGroup('quotaReservations')
      .where('status', '==', 'reserved')
      .where('expiresAtMs', '<=', atMs)
      .limit(limit)
      .get();
    return snapshot.docs.flatMap(document => {
      const uid = document.ref.parent.parent?.id;
      return uid ? [{ uid, operationId: document.id }] : [];
    });
  }

  async createSignedUpload(objectPath: string, contentType: string, contentHash: string) {
    const requiredHeaders = {
      'content-type': contentType,
      'x-goog-meta-sha256': contentHash,
    };
    const [uploadUrl] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
      extensionHeaders: { 'x-goog-meta-sha256': contentHash },
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
    const contentHash = metadata.metadata?.sha256;
    return {
      objectPath,
      byteSize: Number(metadata.size),
      contentType: metadata.contentType ?? '',
      contentHash: typeof contentHash === 'string' ? contentHash : '',
    };
  }

  async deleteObject(objectPath: string) {
    await this.bucket.file(objectPath).delete({ ignoreNotFound: true });
  }
}

let firebaseAssetsService: ReturnType<typeof createPrivateProAssetsService> | undefined;

export function getFirebasePrivateProAssetsService(rateLimit?: Parameters<typeof createPrivateProAssetsService>[2]) {
  return firebaseAssetsService ??= createPrivateProAssetsService(new FirebasePrivateProAssetsPort(), Date.now, rateLimit);
}
