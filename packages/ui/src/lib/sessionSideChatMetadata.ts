import { z } from 'zod';
import type { Message, Metadata, Part } from '@/lib/opencode/model';
import { compareMessagesChronologically } from '@/sync/message-ordering';

// OpenCode assigns new IDs to cloned messages. Capture the fork's last clone,
// not the source message or the fork creation time, before allowing a send.
const boundarySchema = z.object({
  id: z.string().min(1),
  time: z.object({ created: z.number().finite() }),
  // Only the synthetic/non-synthetic distinction affects equal-time ordering.
  role: z.enum(['synthetic', 'user']),
});
const namespaceSchema = z.record(z.string(), z.json());
const markerSchema = z.object({ sideChatBoundary: boundarySchema });

export type SideChatBoundary = z.infer<typeof boundarySchema>;

export function getSideChatBoundary(metadata: Metadata | undefined): SideChatBoundary | null {
  const parsed = markerSchema.safeParse(metadata?.openchamber);
  return parsed.success ? parsed.data.sideChatBoundary : null;
}

export function withSideChatBoundary(metadata: Metadata, message: Message): Metadata {
  const parsed = namespaceSchema.safeParse(metadata.openchamber);
  const namespace = parsed.success ? parsed.data : {};
  return {
    ...metadata,
    openchamber: {
      ...namespace,
      sideChatBoundary: {
        id: message.id,
        time: { created: message.time.created },
        role: message.role === 'synthetic' ? 'synthetic' : 'user',
      },
    },
  };
}

/** Filter the rendered view only; the sync store and model keep all context. */
export function filterSideChatMessages(
  records: Array<{ info: Message; parts: Part[] }>,
  boundary: SideChatBoundary | null,
): Array<{ info: Message; parts: Part[] }> {
  if (!boundary) return records;
  const start = records.findIndex((record) => compareMessagesChronologically(record.info, boundary) > 0);
  if (start < 0) return [];
  return start === 0 ? records : records.slice(start);
}
