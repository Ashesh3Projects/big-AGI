import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertDocxToHTML } from './DocxToMarkdown';


const SIMPLE_DOCX_BASE64 = 'UEsDBAoAAAAAACyHEl0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgALIcSXQvoHGOlAAAA2wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOsQ7CIBCGX4WwW6qDMU2pg8a4uWjiinC2TeCOAFr79kIdXL4/d5f/y7X7j7PsDSGOhJKvq5ozQE1mxF7y2/W02nEWk0KjLCFIPkPk+66dGkP65QATywKMzST5kJJvhIh6AKdiRR4w354UnEp5DL2YKBgfSEOM2e+s2NT1Vjg1Ii/KB5m5pC8IBak7g7XEvErZatjxcri3ouwLw0K/8NcV/7+6L1BLAQIUAAoAAAAAACyHEl0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAAAAAAB3b3JkL1BLAQIUAAoAAAAIACyHEl0L6BxjpQAAANsAAAARAAAAAAAAAAAAAAAAACMAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAHIAAAD3AAAAAAA=';

function arrayBufferFromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, 'base64')).buffer;
}

test('converts a minimal DOCX through the patched Mammoth XML parser', async () => {
  const result = await convertDocxToHTML(arrayBufferFromBase64(SIMPLE_DOCX_BASE64));

  assert.equal(result.html, '<p>Hello patched DOCX</p>');
});

test('rejects malformed DOCX data', async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      convertDocxToHTML(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer),
      /(?:zip|corrupted|central directory|valid \.docx)/i,
    );
  } finally {
    console.error = originalConsoleError;
  }
});
