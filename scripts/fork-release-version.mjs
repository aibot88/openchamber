#!/usr/bin/env node
// Next release version for the aibot88/openchamber fork. Upstream X.Y.Z becomes
// X.Y.(Z*100+n), so every fork build of an upstream version sorts above that
// version and below the next upstream patch. n counts earlier fork releases.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORK_TAG_PREFIX = 'fork-v';
const FORK_BUILDS_PER_UPSTREAM_PATCH = 100;

export const nextForkVersion = (upstreamVersion, existingTags) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(upstreamVersion);
  if (!match) throw new Error(`Unsupported upstream version: ${upstreamVersion}`);
  const [, major, minor, patch] = match;
  const first = Number(patch) * FORK_BUILDS_PER_UPSTREAM_PATCH;
  const limit = first + FORK_BUILDS_PER_UPSTREAM_PATCH;
  const sameLine = new RegExp(`^${FORK_TAG_PREFIX}${major}\\.${minor}\\.(\\d+)$`);
  const released = existingTags
    .map((tag) => sameLine.exec(tag.trim()))
    .filter(Boolean)
    .map((tagMatch) => Number(tagMatch[1]))
    .filter((forkPatch) => forkPatch >= first && forkPatch < limit);
  const next = released.length > 0 ? Math.max(...released) + 1 : first;
  if (next >= limit) throw new Error(`No fork versions left for upstream ${upstreamVersion}`);
  return `${major}.${minor}.${next}`;
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', `${FORK_TAG_PREFIX}*`], { cwd: root, encoding: 'utf8' }).split('\n');
  process.stdout.write(`${nextForkVersion(version, tags)}\n`);
}
