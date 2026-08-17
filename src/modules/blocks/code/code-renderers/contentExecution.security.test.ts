import assert from 'node:assert/strict';
import { test } from 'node:test';

import { htmlSandboxPolicy } from './RenderCodeHtmlIFrame';

test('generated HTML cannot share the application origin', () => {
  const tokens = htmlSandboxPolicy().split(/\s+/).filter(Boolean);
  assert.equal(tokens.includes('allow-same-origin'), false);
  assert.equal(tokens.includes('allow-top-navigation'), false);
  assert.equal(tokens.includes('allow-popups-to-escape-sandbox'), false);
});
