import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { detectContentType, optimizeImage } from 'next/dist/server/image-optimizer';


test('Next 15 optimizes images with the overridden Sharp release', async () => {
  const input = await readFile(new URL('../../../public/icons/favicon-32x32.png', import.meta.url));
  const output = await optimizeImage({
    buffer: input,
    contentType: 'image/webp',
    quality: 75,
    width: 16,
  });

  assert.equal(await detectContentType(output), 'image/webp');
  assert.ok(output.length > 0);
});
