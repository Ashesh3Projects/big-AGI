import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';


test('private Pro build excludes every analytics mount and makes source flags fail closed', () => {
  const app = readFileSync('pages/_app.tsx', 'utf8');
  const google = readFileSync('src/common/components/3rdparty/GoogleAnalytics.tsx', 'utf8');
  const posthog = readFileSync('src/common/components/3rdparty/PostHogAnalytics.tsx', 'utf8');
  const serverPosthog = readFileSync('src/server/posthog/posthog.server.ts', 'utf8');

  assert.match(app, /!privateProClientConfig\.enabled\s*&&\s*hasGoogleAnalytics/);
  assert.match(app, /!privateProClientConfig\.enabled\s*&&\s*hasPostHogAnalytics/);
  assert.match(app, /!privateProClientConfig\.enabled\s*&&\s*Is\.Deployment\.VercelFromFrontend/);
  for (const source of [google, posthog, serverPosthog])
    assert.match(source, /NEXT_PUBLIC_PRIVATE_PRO_ENABLED\s*!==\s*'true'/);
});
