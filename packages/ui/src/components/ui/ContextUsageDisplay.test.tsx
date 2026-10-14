import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nContext } from '@/lib/i18n/react-context';
import { dict } from '@/lib/i18n/messages/en';
import { ContextUsageDisplay } from './ContextUsageDisplay';

const render = (limit: number) => renderToStaticMarkup(
  <I18nContext.Provider value={{ locale: 'en', locales: ['en'], setLocale: () => {}, label: () => 'English', t: (key) => dict[key] }}>
    <ContextUsageDisplay reading={{ state: 'measured', totalTokens: 20_000, percentage: 10 }} contextLimit={limit} showPercentIcon />
  </I18nContext.Provider>,
);

describe('context usage with unknown model capacity', () => {
  test('renders a measured percentage for a reported positive limit', () => {
    const html = render(200_000);
    expect(html).toContain('10.0%');
    expect(html).toContain('aria-valuenow="10"');
  });
  test('does not claim zero usage or a guessed 200K window when the limit is unknown', () => {
    for (const limit of [0, -1, NaN, Infinity]) {
      const html = render(limit);
      expect(html).not.toContain('10.0%');
      expect(html).not.toContain('aria-valuenow');
      expect(html).toContain('\u2014');
    }
  });
});
