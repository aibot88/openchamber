import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nContext } from '@/lib/i18n/react-context';
import { dict } from '@/lib/i18n/messages/en';
import { opencodeClient } from '@/lib/opencode/client';
import type { JsonValue } from '@/lib/opencode/model';

// Render the real component and SDK. Only the network boundary is a fixture;
// no integration command, credentials or user's OpenCode server are accessed.
const originalFetch = globalThis.fetch;
const requests: { method: string; path: string }[] = [];
const connectBodies: JsonValue[] = [];
let status: 'complete' | 'failed' | 'expired' | 'blocked' = 'complete';
let releaseConnect: (() => void) | undefined;
let blockConnect = false;
let releaseStatus: (() => void) | undefined;
let root: Root;
let container: HTMLDivElement;
let connected = 0;
let refreshFails = false;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const json = (data: JsonValue) => new Response(JSON.stringify({ location: {}, data }), { headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  const window = new Window({ url: 'http://localhost/' });
  const values = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, HTMLIFrameElement: window.HTMLIFrameElement,
    localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(values)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  requests.length = 0; connectBodies.length = 0; connected = 0; refreshFails = false; status = 'complete'; blockConnect = false; releaseConnect = undefined; releaseStatus = undefined;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    if (!path.startsWith('/api/integration/fixture-command/connect/command')) throw new Error('Unexpected test network request');
    if (request.method === 'POST') {
      connectBodies.push(await request.json());
      if (blockConnect) await new Promise<void>((resolve) => { releaseConnect = resolve; });
      return json({ attemptID: 'att_fixture', time: { created: 1, expires: 9999999999999 } });
    }
    if (request.method === 'DELETE') { releaseStatus?.(); return new Response(null, { status: 204 }); }
    if (status === 'blocked') {
      await new Promise<void>((resolve) => { releaseStatus = resolve; request.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return json({ status: 'complete', time: { created: 1, expires: 2 } });
    }
    if (status === 'failed') return json({ status, message: 'Keychain access denied', time: { created: 1, expires: 9999999999999 } });
    return json({ status, time: { created: 1, expires: 9999999999999 } });
  };
  opencodeClient.reconnectToRuntimeBaseUrl();
  const { createRoot } = await import('react-dom/client');
  const { ProviderOAuthMethods } = await import('./ProviderOAuthMethods');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(
    <I18nContext.Provider value={{ locale: 'en', locales: ['en'], direction: 'ltr', setLocale: () => {}, label: () => 'English', t: (key) => dict[key] }}>
      <ProviderOAuthMethods integrationId="fixture-command" methods={[{ type: 'command', id: 'desktop-import', label: 'Import fixture desktop login' }]}
        directory="/fixture/project" onConnected={() => { connected++; if (refreshFails) throw new Error('Synthetic catalog failure'); }} />
    </I18nContext.Provider>,
  ));
});

afterEach(async () => {
  releaseConnect?.(); releaseStatus?.();
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  descriptors.clear();
});

const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => { button.click(); });
};
const start = () => click('Connect');

test('command sign-in runs only on click and refreshes once after completion', async () => {
  expect(requests).toHaveLength(0);
  await start(); expect(connected).toBe(1);
  expect(requests.map((request) => request.method)).toEqual(['POST', 'GET']);
  expect(container.textContent).not.toContain('Signing in on the OpenCode host');
});
const nameAccount = async (value: string) => {
  const input = container.querySelector('input');
  if (!input) throw new Error('Missing account name field');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing input value setter');
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
test('saves the optional account name only when connecting and clears it after completion', async () => {
  await nameAccount('  工作账号  ');
  expect(requests).toHaveLength(0);
  await start();
  expect(connectBodies).toEqual([{ methodID: 'desktop-import', label: '工作账号' }]);
  expect(container.querySelector('input')?.value).toBe('');
});
test('an unnamed account uses the host default', async () => {
  await nameAccount('  '); await start();
  expect(connectBodies).toEqual([{ methodID: 'desktop-import' }]);
});
test('a failed import preserves the name for an explicit retry', async () => {
  await nameAccount('Personal'); status = 'failed'; await start();
  expect(container.querySelector('input')?.value).toBe('Personal');
  expect(connectBodies).toHaveLength(1);
  status = 'complete'; await click('Try again');
  expect(connectBodies).toEqual([{ methodID: 'desktop-import', label: 'Personal' }, { methodID: 'desktop-import', label: 'Personal' }]);
  expect(connected).toBe(1);
});
test('catalog refresh failure after a stored credential does not rerun or cancel authentication', async () => {
  refreshFails = true; await start();
  expect(connected).toBe(1);
  expect(requests.map((request) => request.method)).toEqual(['POST', 'GET']);
  expect(container.textContent).not.toContain('Try again');
  expect(container.textContent).not.toContain('Signing in on the OpenCode host');
});
for (const state of ['failed', 'expired'] as const) {
  test(`terminal ${state} leaves a retryable button and does not refresh credentials`, async () => {
    status = state; await start();
    expect(connected).toBe(0);
    expect(container.textContent).toContain(state === 'failed' ? 'Keychain access denied' : 'expired');
    expect(requests).toHaveLength(2);
  });
}
test('cancel before connect returns cancels the late attempt without polling', async () => {
  blockConnect = true; await start();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('OpenCode host');
  await click('Cancel');
  await act(async () => { releaseConnect?.(); });
  expect(requests.map((request) => request.method)).toEqual(['POST', 'DELETE']); expect(connected).toBe(0);
});
test('unmount before connect returns cancels the late attempt', async () => {
  blockConnect = true; await start();
  await act(async () => root.unmount());
  await act(async () => { releaseConnect?.(); });
  expect(requests.map((request) => request.method)).toEqual(['POST', 'DELETE']); expect(connected).toBe(0);
});
test('cancel while status is pending aborts the read and never completes a canceled login', async () => {
  status = 'blocked'; await start(); await click('Cancel');
  expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'DELETE']); expect(connected).toBe(0);
});
