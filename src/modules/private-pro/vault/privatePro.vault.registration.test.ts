import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { importVaultMasterKey } from './privatePro.vault.crypto';
import {
  createPrivateProVaultDeviceRegistration,
  privateProVaultDeviceRegistrationPayload,
  signPrivateProVaultDeviceRegistration,
  unlockPrivateProVaultDeviceRegistrationKey,
  verifyPrivateProVaultDeviceRegistration,
} from './privatePro.vault.registration';


const MASTER_KEY = new Uint8Array(32).fill(0x42);
const UID = 'uid-registration-test';
const DEVICE_ID = 'ddddddddddddddddddddddddddddddddddddddddddd';


describe('private Pro vault device registration proof', () => {
  test('encrypts the private signing key under the vault master key and verifies a legitimate proof', async () => {
    const masterKey = await importVaultMasterKey(MASTER_KEY);
    const registration = await createPrivateProVaultDeviceRegistration(masterKey, UID, 1);
    const privateKey = await unlockPrivateProVaultDeviceRegistrationKey(masterKey, UID, registration, 1);
    const input = { formatVersion: 1 as const, uid: UID, deviceId: DEVICE_ID, keyVersion: 1, operationId: 'register-device-1' };
    const signatureBase64 = await signPrivateProVaultDeviceRegistration(privateKey, input);

    assert.deepEqual(Object.keys(registration.publicJwk).sort(), ['crv', 'kty', 'x', 'y']);
    assert.equal(privateKey.extractable, false);
    assert.equal(await verifyPrivateProVaultDeviceRegistration(registration.publicJwk, input, signatureBase64), true);
    assert.equal(JSON.stringify(registration).includes('uid-registration-test'), false);
  });

  test('binds the signature to UID, device, key version, and operation ID', async () => {
    const masterKey = await importVaultMasterKey(MASTER_KEY);
    const registration = await createPrivateProVaultDeviceRegistration(masterKey, UID, 1);
    const privateKey = await unlockPrivateProVaultDeviceRegistrationKey(masterKey, UID, registration, 1);
    const input = { formatVersion: 1 as const, uid: UID, deviceId: DEVICE_ID, keyVersion: 1, operationId: 'register-device-1' };
    const signature = await signPrivateProVaultDeviceRegistration(privateKey, input);

    for (const tampered of [
      { ...input, uid: 'uid-attacker' },
      { ...input, deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      { ...input, keyVersion: 2 },
      { ...input, operationId: 'register-device-2' },
    ]) assert.equal(await verifyPrivateProVaultDeviceRegistration(registration.publicJwk, tampered, signature), false);
  });

  test('rejects non-scalar payload fields before signing or verification', async () => {
    assert.throws(() => privateProVaultDeviceRegistrationPayload({
      formatVersion: 1,
      uid: '\ud800',
      deviceId: DEVICE_ID,
      keyVersion: 1,
      operationId: 'register-device-1',
    }), /Unicode scalar/i);
  });
});
