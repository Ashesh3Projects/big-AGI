import { FieldPath, type CollectionReference, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';

import { getPrivateProFirestore } from '../firebase/firebase.admin';
import type {
  PrivateProVaultOperationReceipt,
  PrivateProVaultBackupMergeReceipt,
  PrivateProVaultRegistrationChallenge,
  PrivateProVaultRepository,
  PrivateProVaultRepositoryTransaction,
  PrivateProVaultStoredKeyset,
  PrivateProVaultStoredDevice,
  PrivateProVaultStoredRecord,
  PrivateProVaultStoredTombstone,
  PrivateProVaultSecurityEvent,
} from './privatePro.vault.repository';
import { mergePrivateProVaultIndexEntries } from './privatePro.vault.repository';
import { createPrivateProVaultService } from './privatePro.vault.service';


function vaultRoot(uid: string): string {
  return `users/${uid}/vault/data`;
}

function recordCollection(db: Firestore, uid: string): CollectionReference<DocumentData> {
  return db.collection(`${vaultRoot(uid)}/records`);
}

function tombstoneCollection(db: Firestore, uid: string): CollectionReference<DocumentData> {
  return db.collection(`${vaultRoot(uid)}/tombstones`);
}

class FirebasePrivateProVaultTransaction implements PrivateProVaultRepositoryTransaction {
  constructor(
    private readonly db: Firestore,
    private readonly transaction: Transaction,
    private readonly uid: string,
  ) {}

  async getRecord(opaqueRecordId: string) {
    const snapshot = await this.transaction.get(recordCollection(this.db, this.uid).doc(opaqueRecordId));
    return snapshot.exists ? snapshot.data() as PrivateProVaultStoredRecord : null;
  }

  async setRecord(record: PrivateProVaultStoredRecord) {
    this.transaction.set(recordCollection(this.db, this.uid).doc(record.opaqueRecordId), record);
  }

  async deleteRecord(opaqueRecordId: string) {
    this.transaction.delete(recordCollection(this.db, this.uid).doc(opaqueRecordId));
  }

  async getTombstone(opaqueRecordId: string) {
    const snapshot = await this.transaction.get(tombstoneCollection(this.db, this.uid).doc(opaqueRecordId));
    return snapshot.exists ? snapshot.data() as PrivateProVaultStoredTombstone : null;
  }

  async setTombstone(tombstone: PrivateProVaultStoredTombstone) {
    this.transaction.set(tombstoneCollection(this.db, this.uid).doc(tombstone.opaqueRecordId), tombstone);
  }

  async deleteTombstone(opaqueRecordId: string) {
    this.transaction.delete(tombstoneCollection(this.db, this.uid).doc(opaqueRecordId));
  }

  async getOperation(operationId: string) {
    const reference = this.db.doc(`${vaultRoot(this.uid)}/operations/${operationId}`);
    const snapshot = await this.transaction.get(reference);
    return snapshot.exists ? snapshot.data() as PrivateProVaultOperationReceipt : null;
  }

  async createOperation(operation: PrivateProVaultOperationReceipt) {
    this.transaction.create(this.db.doc(`${vaultRoot(this.uid)}/operations/${operation.operationId}`), operation);
  }

  async getBackupMerge(operationId: string) {
    const reference = this.db.doc(`${vaultRoot(this.uid)}/backupMerges/${operationId}`);
    const snapshot = await this.transaction.get(reference);
    return snapshot.exists ? snapshot.data() as PrivateProVaultBackupMergeReceipt : null;
  }

  async createBackupMerge(receipt: PrivateProVaultBackupMergeReceipt) {
    this.transaction.create(this.db.doc(`${vaultRoot(this.uid)}/backupMerges/${receipt.operationId}`), receipt);
  }

  async getKeyset() {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/keysets/current`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultStoredKeyset : null;
  }

  async setKeyset(keyset: PrivateProVaultStoredKeyset) {
    this.transaction.set(this.db.doc(`${vaultRoot(this.uid)}/keysets/current`), keyset);
  }

  async getDevice(deviceId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/devices/${deviceId}`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultStoredDevice : null;
  }

  async setDevice(device: PrivateProVaultStoredDevice) {
    this.transaction.set(this.db.doc(`${vaultRoot(this.uid)}/devices/${device.deviceId}`), device);
  }

  async listDevices() {
    const snapshot = await this.transaction.get(this.db.collection(`${vaultRoot(this.uid)}/devices`));
    return snapshot.docs.map(document => document.data() as PrivateProVaultStoredDevice);
  }

  async getRegistrationChallenge(challengeId: string) {
    const snapshot = await this.transaction.get(this.db.doc(`${vaultRoot(this.uid)}/registrationChallenges/${challengeId}`));
    return snapshot.exists ? snapshot.data() as PrivateProVaultRegistrationChallenge : null;
  }

  async createRegistrationChallenge(challenge: PrivateProVaultRegistrationChallenge) {
    this.transaction.create(this.db.doc(`${vaultRoot(this.uid)}/registrationChallenges/${challenge.challengeId}`), challenge);
  }

  async deleteRegistrationChallenge(challengeId: string) {
    this.transaction.delete(this.db.doc(`${vaultRoot(this.uid)}/registrationChallenges/${challengeId}`));
  }

  async createSecurityEvent(event: PrivateProVaultSecurityEvent) {
    this.transaction.create(this.db.doc(`${vaultRoot(this.uid)}/securityEvents/${event.eventId}`), event);
  }

}

export class FirebasePrivateProVaultRepository implements PrivateProVaultRepository {
  constructor(private readonly db: Firestore = getPrivateProFirestore()) {}

  transaction<T>(uid: string, callback: (transaction: PrivateProVaultRepositoryTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(transaction => callback(new FirebasePrivateProVaultTransaction(this.db, transaction, uid)));
  }

  async listIndexEntries(uid: string, afterOpaqueRecordId: string | null, limit: number) {
    const createQuery = (collection: CollectionReference<DocumentData>) => {
      const ordered = collection.orderBy(FieldPath.documentId()).limit(limit);
      return afterOpaqueRecordId === null ? ordered : ordered.startAfter(afterOpaqueRecordId);
    };
    const [records, tombstones] = await this.db.runTransaction(transaction => Promise.all([
      transaction.get(createQuery(recordCollection(this.db, uid))),
      transaction.get(createQuery(tombstoneCollection(this.db, uid))),
    ]), { readOnly: true });
    return mergePrivateProVaultIndexEntries(
      records.docs.map(document => document.data() as PrivateProVaultStoredRecord),
      tombstones.docs.map(document => document.data() as PrivateProVaultStoredTombstone),
      limit,
    );
  }

  async getRecords(uid: string, opaqueRecordIds: readonly string[]) {
    if (opaqueRecordIds.length === 0) return [];
    const snapshots = await this.db.getAll(...opaqueRecordIds.map(opaqueRecordId => recordCollection(this.db, uid).doc(opaqueRecordId)));
    return snapshots.flatMap(snapshot => snapshot.exists ? [snapshot.data() as PrivateProVaultStoredRecord] : []);
  }
}

let firebasePrivateProVaultService: ReturnType<typeof createPrivateProVaultService> | undefined;

export function getFirebasePrivateProVaultService() {
  return firebasePrivateProVaultService ??= createPrivateProVaultService(new FirebasePrivateProVaultRepository());
}
