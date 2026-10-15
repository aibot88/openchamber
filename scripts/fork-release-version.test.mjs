import assert from 'node:assert/strict';
import test from 'node:test';

import { nextForkVersion } from './fork-release-version.mjs';

test('the first fork build of an upstream version starts its own block', () => {
  assert.equal(nextForkVersion('2.3.3', []), '2.3.300');
  assert.equal(nextForkVersion('2.4.0', ['fork-v2.3.300']), '2.4.0');
});

test('later fork builds of the same upstream version count up', () => {
  assert.equal(nextForkVersion('2.3.3', ['fork-v2.3.300', 'fork-v2.3.301', 'v2.3.3', '']), '2.3.302');
});

test('fork builds of other upstream patches do not take numbers', () => {
  assert.equal(nextForkVersion('2.3.3', ['fork-v2.3.200', 'fork-v2.3.201', 'fork-v2.4.300']), '2.3.300');
});

test('rejects versions it cannot place and full blocks', () => {
  assert.throws(() => nextForkVersion('2.3.3-beta.1', []), /Unsupported upstream version/);
  assert.throws(() => nextForkVersion('2.3.3', ['fork-v2.3.399']), /No fork versions left/);
});
