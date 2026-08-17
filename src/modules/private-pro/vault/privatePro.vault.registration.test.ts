import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { importVaultMasterKey } from './privatePro.vault.crypto';
import {
  createPrivateProVaultEnrollmentAuthority,
  privateProVaultDeviceRegistrationPayload,
  rewrapPrivateProVaultEnrollmentPassword,
  signPrivateProVaultDeviceRegistration,
  unlockPrivateProVaultEnrollmentKey,
  verifyPrivateProVaultDeviceRegistration,
} from './privatePro.vault.registration';


const MASTER_KEY = new Uint8Array(32).fill(0x42);
const UID = 'uid-registration-test';
const DEVICE_ID = 'ddddddddddddddddddddddddddddddddddddddddddd';
const CHALLENGE_ID = 'ccccccccccccccccccccccccccccccccccccccccccc';
const CHALLENGE_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';


async function aesKey(fill: number): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

function challenge() {
  return {
    formatVersion: 1 as const,
    uid: UID,
    deviceId: DEVICE_ID,
    keyVersion: 1,
    challengeId: CHALLENGE_ID,
    challengeBase64: CHALLENGE_BASE64,
    expiresAtMs: 305_000,
  };
}


describe('private Pro vault enrollment authority', () => {
  test('keeps the enrollment private key outside the vault master and device-key authority', async () => {
    const passwordWrappingKey = await aesKey(0x11);
    const recoveryWrappingKey = await aesKey(0x22);
    const masterKey = await importVaultMasterKey(MASTER_KEY);
    const created = await createPrivateProVaultEnrollmentAuthority(passwordWrappingKey, recoveryWrappingKey, UID, 1);

    const passwordKey = await unlockPrivateProVaultEnrollmentKey(created.authority, 'password', passwordWrappingKey, UID, 1);
    const recoveryKey = await unlockPrivateProVaultEnrollmentKey(created.authority, 'recovery', recoveryWrappingKey, UID, 1);

    assert.equal(passwordKey.extractable, false);
    assert.equal(recoveryKey.extractable, false);
    await assert.rejects(
      unlockPrivateProVaultEnrollmentKey(created.authority, 'password', masterKey, UID, 1),
      /enrollment credentials are invalid/i,
    );
    assert.deepEqual(Object.keys(created.authority).sort(), ['algorithm', 'keyVersion', 'passwordEnvelope', 'publicJwk', 'recoveryEnvelope']);
    assert.equal(JSON.stringify(created.authority).includes(UID), false);
  });

  test('rewraps only the password enrollment envelope while retaining recovery access', async () => {
    const currentPasswordKey = await aesKey(0x11);
    const newPasswordKey = await aesKey(0x33);
    const recoveryKey = await aesKey(0x22);
    const created = await createPrivateProVaultEnrollmentAuthority(currentPasswordKey, recoveryKey, UID, 1);
    const rotated = await rewrapPrivateProVaultEnrollmentPassword(created.authority, currentPasswordKey, newPasswordKey, UID, 1);

    assert.notDeepEqual(rotated.passwordEnvelope, created.authority.passwordEnvelope);
    assert.deepEqual(rotated.recoveryEnvelope, created.authority.recoveryEnvelope);
    await assert.rejects(
      unlockPrivateProVaultEnrollmentKey(rotated, 'password', currentPasswordKey, UID, 1),
      /enrollment credentials are invalid/i,
    );
    assert.ok(await unlockPrivateProVaultEnrollmentKey(rotated, 'password', newPasswordKey, UID, 1));
    assert.ok(await unlockPrivateProVaultEnrollmentKey(rotated, 'recovery', recoveryKey, UID, 1));
  });
});

describe('private Pro vault device registration challenge proof', () => {
  test('verifies a legitimate server challenge proof', async () => {
    const passwordWrappingKey = await aesKey(0x11);
    const recoveryWrappingKey = await aesKey(0x22);
    const created = await createPrivateProVaultEnrollmentAuthority(passwordWrappingKey, recoveryWrappingKey, UID, 1);
    const privateKey = await unlockPrivateProVaultEnrollmentKey(created.authority, 'password', passwordWrappingKey, UID, 1);
    const input = challenge();
    const signatureBase64 = await signPrivateProVaultDeviceRegistration(privateKey, input);

    assert.equal(await verifyPrivateProVaultDeviceRegistration(created.authority.publicJwk, input, signatureBase64), true);
  });

  test('binds the signature to UID, device, key version, challenge ID, data, and expiry', async () => {
    const passwordWrappingKey = await aesKey(0x11);
    const recoveryWrappingKey = await aesKey(0x22);
    const created = await createPrivateProVaultEnrollmentAuthority(passwordWrappingKey, recoveryWrappingKey, UID, 1);
    const privateKey = await unlockPrivateProVaultEnrollmentKey(created.authority, 'password', passwordWrappingKey, UID, 1);
    const input = challenge();
    const signature = await signPrivateProVaultDeviceRegistration(privateKey, input);

    for (const tampered of [
      { ...input, uid: 'uid-attacker' },
      { ...input, deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      { ...input, keyVersion: 2 },
      { ...input, challengeId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      { ...input, challengeBase64: 'ICEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE=' },
      { ...input, expiresAtMs: input.expiresAtMs + 1 },
    ]) assert.equal(await verifyPrivateProVaultDeviceRegistration(created.authority.publicJwk, tampered, signature), false);
  });

  test('rejects non-scalar payload fields before signing or verification', () => {
    assert.throws(() => privateProVaultDeviceRegistrationPayload({
      ...challenge(),
      uid: '\ud800',
    }), /Unicode scalar/i);
  });
});
