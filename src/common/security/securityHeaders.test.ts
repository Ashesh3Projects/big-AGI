import assert from 'node:assert/strict';
import { test } from 'node:test';

import { privateProContentSecurityPolicy, privateProSecurityHeaders } from './securityHeaders';


test('private Pro emits the required browser security headers', () => {
  const headers = new Map(privateProSecurityHeaders().map(({ key, value }) => [key.toLowerCase(), value]));
  assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(headers.get('content-security-policy') ?? '', /object-src 'none'/);
  assert.equal(headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains; preload');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Firebase HTTP-referrer restrictions require an origin Referer without path or query leakage');
  assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(headers.get('permissions-policy') ?? '', /geolocation=\(\)/);
  assert.doesNotMatch(headers.get('content-security-policy') ?? '', /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
});

test('private Pro CSP permits Firebase, Google sign-in, media, workers, and supported AI providers', () => {
  const policy = privateProContentSecurityPolicy();

  assert.match(policy, /connect-src[^;]*https:\/\/identitytoolkit\.googleapis\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/firestore\.googleapis\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/content-firebaseappcheck\.googleapis\.com/);
  assert.doesNotMatch(policy, /connect-src[^;]*https:\/\/firebaseinstallations\.googleapis\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/storage\.googleapis\.com/);
  assert.match(policy, /frame-src[^;]*https:\/\/accounts\.google\.com/);
  assert.match(policy, /img-src[^;]*data:[^;]*blob:/);
  assert.match(policy, /media-src[^;]*data:[^;]*blob:/);
  assert.match(policy, /worker-src[^;]*'self'[^;]*blob:/);
  assert.match(policy, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-eval'/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.openai\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.anthropic\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/generativelanguage\.googleapis\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/openrouter\.ai/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.groq\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.mistral\.ai/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.deepseek\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.together\.xyz/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.x\.ai/);
  assert.match(policy, /connect-src[^;]*https:\/\/\*\.openai\.azure\.com/);
  assert.match(policy, /connect-src[^;]*https:\/\/api\.deepgram\.com/);
});

test('private Pro CSP permits custom secure endpoints without permitting analytics or arbitrary insecure endpoints', () => {
  const policy = privateProContentSecurityPolicy();
  const connectSource = policy.match(/(?:^|; )connect-src ([^;]+)/)?.[1] ?? '';
  const connectSources = connectSource.split(/\s+/);

  assert.ok(connectSources.includes('https:'));
  assert.ok(connectSources.includes('wss:'));
  assert.doesNotMatch(policy, /posthog|google-analytics|googletagmanager|analytics\.google/);
  assert.ok(!connectSources.includes('*'));
  assert.ok(!connectSources.includes('http:'));
  assert.deepEqual(connectSources.filter(source => source.startsWith('http://')), ['http://localhost:*', 'http://127.0.0.1:*']);
  assert.doesNotMatch(policy, /(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
});
