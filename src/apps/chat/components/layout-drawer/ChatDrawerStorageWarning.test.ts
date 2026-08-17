import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';


const privateProEnabled = process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true';


describe('chat drawer storage warning', () => {
  test('matches the deployment storage model', async () => {
    const { ChatDrawerStorageWarning } = await import('./ChatDrawerStorageWarning');
    const markup = renderToStaticMarkup(React.createElement(ChatDrawerStorageWarning));

    assert.equal(markup.includes('Chats are saved only in this browser.'), !privateProEnabled);
  });
});
