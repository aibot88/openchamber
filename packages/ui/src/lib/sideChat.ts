import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import { forkAfterMessage, forkFromLastCompletedTurn, patchSessionMetadata } from '@/sync/session-actions';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { withSideChatBoundary } from '@/lib/sessionSideChatMetadata';

/** The context-panel chat belongs to the full web/desktop layout. */
export function isSideChatAvailable(isMobile: boolean): boolean {
  return !isMobile && !isMobileSurfaceRuntime() && !isVSCodeRuntime();
}

/** Fork into the main chat's panel without changing its selected session. */
export async function forkSideChat(sessionId: string, messageId?: string): Promise<Session | null> {
  if (!isSideChatAvailable(useUIStore.getState().isMobile)) {
    throw new Error('Side chat requires the desktop or full web layout');
  }
  // Capture the owner before awaiting the fork. Navigation during creation
  // leaves the tab in the source workspace, rather than opening it elsewhere.
  const panelDirectory = resolveEffectiveDirectory();
  if (!panelDirectory) throw new Error('Side chat has no panel directory');

  const runtimeKey = getRuntimeKey();
  // Do not expose the composer until the inherited-history marker is durable.
  // A failed marker write leaves the fork available in the session list.
  const deferOpen = () => undefined;
  const fork = messageId
    ? await forkAfterMessage(sessionId, messageId, deferOpen)
    : await forkFromLastCompletedTurn(sessionId, deferOpen);
  if (!fork || getRuntimeKey() !== runtimeKey) return null;
  const cloned = await opencodeClient.getSessionMessages(fork.id, { limit: 1 }, fork.directory);
  if (getRuntimeKey() !== runtimeKey) return null;
  const boundary = cloned.items.at(-1)?.info;
  if (!boundary) throw new Error('Side chat inherited-history boundary is unavailable');
  const session = await patchSessionMetadata(fork.id, fork.directory,
    (metadata) => withSideChatBoundary(metadata, boundary), runtimeKey);
  if (getRuntimeKey() !== runtimeKey) return null;
  useUIStore.getState().openContextPanelTab(panelDirectory, {
    mode: 'chat',
    dedupeKey: `session:${session.id}`,
    label: session.title,
    sessionTitleFallback: session.title,
    targetDirectory: session.directory,
  });
  return session;
}
