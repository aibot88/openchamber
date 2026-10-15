import { describe, expect, test } from 'bun:test';
import type { Message, Metadata, Part } from '@/lib/opencode/model';
import { filterSideChatMessages, getSideChatBoundary, withSideChatBoundary } from './sessionSideChatMetadata';
type SessionMessageRecord = { info: Message; parts: Part[] };

const record = (id: string, created: number, role: 'user' | 'synthetic' = 'user'): SessionMessageRecord => ({
  info: role === 'synthetic'
    ? { id, sessionID: 'fork', role, time: { created }, text: 'context' }
    : { id, sessionID: 'fork', role, time: { created } },
  parts: [],
});

describe('side chat inherited history', () => {
  test('persists the cloned boundary while retaining unrelated metadata', () => {
    const metadata: Metadata = { extra: true, openchamber: { goal: { id: 'goal' } } };
    const marked = withSideChatBoundary(metadata, record('clone', 10).info);
    expect(marked.openchamber).toEqual({ goal: { id: 'goal' }, sideChatBoundary: {
      id: 'clone', role: 'user', time: { created: 10 },
    } });
    expect(getSideChatBoundary(JSON.parse(JSON.stringify(marked)))).toEqual(getSideChatBoundary(marked));
    expect(metadata.openchamber).toEqual({ goal: { id: 'goal' } });
  });

  test('old or malformed metadata gives no display marker', () => {
    const cases: Array<Metadata | undefined> = [undefined, {}, { openchamber: [] }, { openchamber: { sideChatBoundary: 'clone' } },
      { openchamber: { sideChatBoundary: { id: '', role: 'user', time: { created: 10 } } } }];
    for (const metadata of cases) {
      expect(getSideChatBoundary(metadata)).toBeNull();
    }
  });

  test('a fresh side chat hides every clone without changing stored context', () => {
    const inherited = [record('a', 1), record('clone', 10)];
    const boundary = getSideChatBoundary(withSideChatBoundary({}, inherited[1].info));
    expect(filterSideChatMessages(inherited, boundary)).toEqual([]);
    expect(inherited).toHaveLength(2);
  });

  test('only new side messages appear, including when IDs roll over', () => {
    const inherited = record('msg_fff_clone', 10);
    const own = record('msg_000_new', 11);
    const records = [record('old', 1), inherited, own];
    const boundary = getSideChatBoundary(withSideChatBoundary({}, inherited.info));
    expect(filterSideChatMessages(records, boundary)).toEqual([own]);
    expect(records).toHaveLength(3);
    expect(filterSideChatMessages(records, null)).toBe(records);
  });

  test('a paginated suffix keeps its identity when the marker is outside the window', () => {
    const own = [record('new1', 20), record('new2', 30)];
    const boundary = getSideChatBoundary(withSideChatBoundary({}, record('clone', 10).info));
    expect(filterSideChatMessages(own, boundary)).toBe(own);
    expect(filterSideChatMessages([record('old', 1), record('clone', 10), ...own], boundary)).toEqual(own);
  });

  test('revert removing the marker cannot expose earlier inherited records', () => {
    const boundary = getSideChatBoundary(withSideChatBoundary({}, record('clone', 10).info));
    expect(filterSideChatMessages([record('old', 1)], boundary)).toEqual([]);
  });

  test('equal-time synthetic context follows the canonical ordering', () => {
    const synthetic = record('z', 10, 'synthetic');
    const prompt = record('a', 10);
    const boundary = getSideChatBoundary(withSideChatBoundary({}, synthetic.info));
    expect(filterSideChatMessages([synthetic, prompt], boundary)).toEqual([prompt]);
    const userBoundary = getSideChatBoundary(withSideChatBoundary({}, prompt.info));
    expect(filterSideChatMessages([synthetic, prompt, record('b', 10)], userBoundary)).toEqual([record('b', 10)]);
  });
});
