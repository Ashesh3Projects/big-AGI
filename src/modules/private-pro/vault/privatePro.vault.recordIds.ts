import { hmacVaultIdentifier } from './privatePro.vault.crypto';
import type { PrivateProVaultRecordType } from './privatePro.vault.types';


export async function privateProVaultRecordId(
  identifierKey: CryptoKey,
  recordType: PrivateProVaultRecordType,
  logicalId: string,
): Promise<string> {
  if (!logicalId) throw new Error('Private Pro vault logical record IDs must be non-empty.');
  return hmacVaultIdentifier(identifierKey, `private-pro-vault-record/${recordType}`, logicalId);
}

export async function assertPrivateProVaultRecordId(
  identifierKey: CryptoKey,
  recordType: PrivateProVaultRecordType,
  logicalId: string,
  recordId: string,
): Promise<void> {
  const expected = await privateProVaultRecordId(identifierKey, recordType, logicalId);
  if (recordId !== expected)
    throw new Error(`Opaque ${recordType} record ID does not match its decrypted value.`);
}
