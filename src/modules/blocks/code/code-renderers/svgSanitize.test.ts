import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sanitizeRenderedSvg } from './svgSanitize';

describe('SVG sanitizer', () => {
  test('removes active content and external references', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><iframe srcdoc="bad"></iframe></foreignObject>
      <image href="javascript:alert(1)" />
      <a href="https://evil.invalid/"><text>open</text></a>
    </svg>`;
    const clean = sanitizeRenderedSvg(dirty);
    assert.doesNotMatch(clean, /script|foreignObject|onload|javascript:|evil\.invalid/i);
    assert.match(clean, /^<svg\b/);
  });

  test('rejects non-SVG roots', () => {
    assert.throws(() => sanitizeRenderedSvg('<html></html>'), /SVG/i);
  });

  test('drops animation, unknown elements, and unsafe URL escapes', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg">
      <style>.bad { fill: url(https://evil.invalid/a.svg#paint); }</style>
      <animate attributeName="x" from="0" to="1" />
      <set attributeName="display" to="none" />
      <discard begin="click" />
      <use href="https://evil.invalid/icons.svg#icon" />
      <g style="fill:url( javascript:alert(1) )" data-safe="kept">
        <unknown><rect width="10" height="10" /></unknown>
      </g>
    </svg>`;
    const clean = sanitizeRenderedSvg(dirty);
    assert.doesNotMatch(clean, /<style|<animate|<set|<discard|<use|<unknown|url\s*\(/i);
    assert.match(clean, /data-safe="kept"/);
  });

  test('preserves common diagram elements and local fragment references', () => {
    const diagram = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" role="img" aria-labelledby="title desc">
      <title id="title">Example</title><desc id="desc">Safe diagram</desc>
      <defs>
        <linearGradient id="paint"><stop offset="0%" stop-color="#fff" /></linearGradient>
        <clipPath id="clip"><rect width="100" height="50" /></clipPath>
        <filter id="shadow"><feGaussianBlur stdDeviation="2" /></filter>
        <path id="shape" d="M0 0 L10 10" />
      </defs>
      <g clip-path="url(#clip)" filter="url(#shadow)" fill="url(#paint)">
        <use href="#shape" />
        <text x="5" y="20"><tspan>Safe</tspan></text>
      </g>
    </svg>`;
    const clean = sanitizeRenderedSvg(diagram);
    assert.match(clean, /<linearGradient\b/);
    assert.match(clean, /<clipPath\b/);
    assert.match(clean, /<feGaussianBlur\b/);
    assert.match(clean, /href="#shape"/);
    assert.match(clean, /fill="url\(#paint\)"/);
    assert.match(clean, /<tspan>Safe<\/tspan>/);
  });

  test('allows embedded raster data images but removes other image resources', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg">
      <image id="safe" href="data:image/png;base64,iVBORw0KGgo=" />
      <image id="svg-data" href="data:image/svg+xml,%3Csvg%20onload='alert(1)'/%3E" />
      <image id="external" href="//evil.invalid/image.png" />
    </svg>`;
    const clean = sanitizeRenderedSvg(dirty);
    assert.match(clean, /id="safe" href="data:image\/png;base64,iVBORw0KGgo="/);
    assert.doesNotMatch(clean, /svg-data[^>]+href=/);
    assert.doesNotMatch(clean, /external[^>]+href=/);
  });

  test('removes CSS-driven animation and escaped resource URLs', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg">
      <style>@keyframes pulse { to { opacity: 0 } } .pulse { animation: pulse 1s infinite }</style>
      <rect id="animated" style="animation-name:pulse" width="10" height="10" />
      <rect id="escaped" style="fill:u\\72 l(https://evil.invalid/paint.svg#x)" width="10" height="10" />
    </svg>`;
    const clean = sanitizeRenderedSvg(dirty);
    assert.doesNotMatch(clean, /@keyframes|animation(?:-name)?\s*:/i);
    assert.doesNotMatch(clean, /evil\.invalid|url\s*\(/i);
  });
});
