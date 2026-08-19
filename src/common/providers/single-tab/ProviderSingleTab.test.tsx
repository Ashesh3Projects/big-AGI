import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderSingleTab } from './ProviderSingleTab';


describe('ProviderSingleTab', () => {
  test('disabled mode renders children during server rendering without entering the lock gate', () => {
    const markup = renderToStaticMarkup(React.createElement(
      ProviderSingleTab,
      { enabled: false },
      React.createElement('main', null, 'Private Pro workspace'),
    ));

    assert.match(markup, /<main>Private Pro workspace<\/main>/);
    assert.doesNotMatch(markup, /data-stage="single-tab"/);
  });

  test('enabled mode retains the existing undecided lock gate', () => {
    const markup = renderToStaticMarkup(React.createElement(
      ProviderSingleTab,
      { enabled: true },
      React.createElement('main', null, 'Open workspace'),
    ));

    assert.match(markup, /data-stage="single-tab"/);
    assert.doesNotMatch(markup, /<main>Open workspace<\/main>/);
  });
});
