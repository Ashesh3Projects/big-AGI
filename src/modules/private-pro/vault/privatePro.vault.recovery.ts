const RECOVERY_KEY_BYTES = 32;
const RECOVERY_CHECKSUM_BYTES = 3;
const RECOVERY_KEY_CHARACTERS = 56;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';


function checksum(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x800000 ? (crc << 1 ^ 0x1864cfb) & 0xffffff : crc << 1 & 0xffffff;
  }
  return Uint8Array.of(crc >> 16, crc >> 8 & 0xff, crc & 0xff);
}

function displayRecoveryKey(bytes: Uint8Array): string {
  const payload = new Uint8Array(RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES);
  payload.set(bytes);
  payload.set(checksum(bytes), RECOVERY_KEY_BYTES);
  let accumulator = 0;
  let accumulatorBits = 0;
  let encoded = '';
  for (const byte of payload) {
    accumulator = accumulator << 8 | byte;
    accumulatorBits += 8;
    while (accumulatorBits >= 5) {
      accumulatorBits -= 5;
      encoded += BASE32_ALPHABET[(accumulator >> accumulatorBits) & 31];
    }
  }
  return encoded.match(/.{4}/g)?.join('-') ?? encoded;
}

export function generateRecoveryKey(): { display: string; bytes: Uint8Array } {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  return { display: displayRecoveryKey(bytes), bytes };
}

export function parseRecoveryKey(display: string): Uint8Array {
  const normalized = display.replace(/[\s-]/g, '').toUpperCase();
  if (normalized.length !== RECOVERY_KEY_CHARACTERS)
    throw new Error('Recovery key length is invalid.');

  const payload = new Uint8Array(RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES);
  let bitIndex = 0;
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0)
      throw new Error('Recovery key contains invalid characters.');
    for (let bit = 4; bit >= 0; bit--) {
      const valueBit = value >> bit & 1;
      payload[Math.floor(bitIndex / 8)] |= valueBit << (7 - bitIndex % 8);
      bitIndex++;
    }
  }

  const bytes = payload.slice(0, RECOVERY_KEY_BYTES);
  const receivedChecksum = payload.slice(RECOVERY_KEY_BYTES);
  const expectedChecksum = checksum(bytes);
  if (!receivedChecksum.every((byte, index) => byte === expectedChecksum[index]))
    throw new Error('Recovery key checksum is invalid.');
  return bytes;
}
