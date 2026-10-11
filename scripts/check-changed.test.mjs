import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRatchetViolations, readOxlintDiagnostics } from './check-changed.mjs';

const counts = (entries) => new Map(entries.map(([file, rule, count]) => [`${file}\0${rule}`, count]));

test('old findings may stay or shrink', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]])), []);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 1]])), []);
});

test('code moved into a new shared file is not new', () => {
  const base = counts([['a.js', 'anti-slop(no-runtime-typeof)', 2], ['b.js', 'anti-slop(no-runtime-typeof)', 2]]);
  const current = counts([['shared.js', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, current), []);
});

test('a rule that grows across the change is a violation, naming the files it grew in', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3], ['a.ts', 'anti-slop(no-unknown-returns)', 2]]);
  const current = counts([
    ['a.ts', 'anti-slop(no-runtime-typeof)', 1],
    ['a.ts', 'anti-slop(no-unknown-returns)', 2],
    ['new.ts', 'anti-slop(no-unknown-returns)', 1],
  ]);
  assert.deepEqual(findRatchetViolations(base, current), [
    { rule: 'anti-slop(no-unknown-returns)', base: 2, current: 3, files: ['new.ts'] },
  ]);
});

const noFilesMessage = 'No files found to lint. Please check your paths and ignore patterns.';
const processResult = (report, status = 0) => ({ status, signal: null, stdout: JSON.stringify(report), stderr: '' });

test('normal JSON reports retain diagnostics, including exit 1 findings for the ratchet', () => {
  const diagnostics = [{ filename: 'a.ts', code: 'anti-slop(no-runtime-typeof)' }];
  for (const status of [0, 1]) {
    assert.deepEqual(readOxlintDiagnostics(processResult({ diagnostics, number_of_files: 1 }, status)), diagnostics);
  }
  assert.deepEqual(readOxlintDiagnostics(processResult({ diagnostics: [], number_of_files: 1 })), []);
});

test('a zero-file JSON report with the known ignored-files prefix is empty', () => {
  for (const newline of ['\n', '\r\n']) {
    const result = processResult({ diagnostics: [], number_of_files: 0 }, 1);
    result.stdout = `${noFilesMessage}${newline}${result.stdout}${newline}`;
    assert.deepEqual(readOxlintDiagnostics(result), []);
  }
});

test('the ignored-files message alone is not a successful report', () => {
  assert.throws(() => readOxlintDiagnostics({ status: 1, stdout: noFilesMessage, stderr: '' }), /produced no report/);
});

test('the known prefix cannot hide findings or a nonzero file count', () => {
  for (const report of [{ diagnostics: [], number_of_files: 1 }, { diagnostics: [{}], number_of_files: 0 }]) {
    const result = processResult(report, 1);
    result.stdout = `${noFilesMessage}\n${result.stdout}`;
    assert.throws(() => readOxlintDiagnostics(result), /inconsistent zero-file report/);
  }
});

test('invalid JSON and malformed diagnostics fail closed', () => {
  for (const report of [{}, { diagnostics: null }, { diagnostics: 'not an array' }]) {
    assert.throws(() => readOxlintDiagnostics(processResult(report)), /invalid diagnostics report/);
  }
  const result = processResult({ diagnostics: [] });
  result.stdout = 'Unexpected tool output\n' + result.stdout;
  assert.throws(() => readOxlintDiagnostics(result), SyntaxError);
});

test('fatal exits, signals and spawn failures are not empty reports', () => {
  for (const failure of [{ status: 2 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    assert.throws(() => readOxlintDiagnostics({ ...processResult({ diagnostics: [], number_of_files: 0 }), ...failure }), /did not complete/);
  }
  assert.throws(() => readOxlintDiagnostics(processResult({ diagnostics: [], number_of_files: 1 }, 1)), /unsuccessfully without diagnostics/);
});

test('the real oxlint command reports a wholly ignored source file without breaking JSON parsing', () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  // Oxlint resolves ignore patterns against the repository config directory.
  // Keep this fixture inside that ignored directory to exercise the real case.
  const directory = mkdtempSync(path.join(repository, '.opencode', 'check-changed-fixture-'));
  try {
    const fixture = path.join(directory, 'fixture.ts');
    writeFileSync(fixture, 'export const fixture = 1;\n');
    const result = spawnSync('bunx', ['oxlint', '-c', path.join(repository, 'oxlint.config.ts'), '-f', 'json', path.relative(repository, fixture)], {
      cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    assert.match(result.stdout, /^No files found to lint\./);
    assert.deepEqual(readOxlintDiagnostics(result), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
