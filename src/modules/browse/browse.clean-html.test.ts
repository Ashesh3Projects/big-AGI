import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanHtml } from './browse.clean-html';


test('removes executable and tracking content from browsed HTML', () => {
  const html = cleanHtml(`
    <!doctype html>
    <html>
      <head><meta name="description" content="Article"><script>alert(1)</script></head>
      <body>
        <main>
          <article>
            <a href="https://example.com/read?id=7&utm_source=test#part" onclick="steal()">Read</a>
            <a href="javascript:alert(1)">Unsafe</a>
            <span data-tracking="secret">Tracker</span>
            <!-- private comment -->
            <p style="color: red" aria-label="copy">Body</p>
          </article>
        </main>
      </body>
    </html>
  `);

  assert.doesNotMatch(html, /<script|javascript:|alert\(1\)|onclick|data-tracking|private comment|utm_source|style=|aria-label=/i);
  assert.match(html, /href="https:\/\/example\.com\/read\?id=7#part"/);
  assert.match(html, />Read<|>Unsafe<|>Body</);
});

test('preserves valid document metadata and media attributes', () => {
  const html = cleanHtml(`
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <meta name="description" content="Summary">
        <meta name="robots" content="noindex">
      </head>
      <body><img src="https://example.com/a.png" alt="A" width="10" height="20" loading="lazy"></body>
    </html>
  `);

  assert.match(html, /meta charset="utf-8"/);
  assert.match(html, /name="viewport" content="width=device-width"/);
  assert.match(html, /name="description" content="Summary"/);
  assert.doesNotMatch(html, /name="robots"|loading=/);
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png" alt="A" width="10" height="20">/);
});
