import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildSandboxedHtmlDocument, htmlSandboxPolicy, RenderCodeHtmlIFrame } from './RenderCodeHtmlIFrame';

test('generated HTML cannot share the application origin', () => {
  const tokens = htmlSandboxPolicy().split(/\s+/).filter(Boolean);
  assert.equal(tokens.includes('allow-same-origin'), false);
  assert.equal(tokens.includes('allow-top-navigation'), false);
  assert.equal(tokens.includes('allow-popups-to-escape-sandbox'), false);
});

test('sandbox document defines its CSP before generated HTML', () => {
  const generatedHtml = '<script>window.generated = true;</script><main>Interactive output</main>';
  const document = buildSandboxedHtmlDocument(generatedHtml);

  assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf(generatedHtml));
  assert.ok(document.includes(generatedHtml));
});

test('generated HTML is rendered through srcDoc in the safe sandbox', () => {
  const markup = renderToStaticMarkup(React.createElement(RenderCodeHtmlIFrame, { htmlCode: '<main>Interactive output</main>' }));

  assert.ok(markup.includes('srcDoc='));
  assert.ok(markup.includes('sandbox="allow-scripts allow-forms"'));
});
