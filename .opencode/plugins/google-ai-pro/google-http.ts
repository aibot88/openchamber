import { z } from "zod";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const googleErrorSchema = z.object({ error: z.object({
  status: z.enum([
    "INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED",
    "RESOURCE_EXHAUSTED", "NOT_FOUND", "FAILED_PRECONDITION",
    "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED",
  ]),
}) });

export async function jsonResponse(response: Response, description: string): Promise<unknown> {
  if (!response.ok) {
    // Only expose a known RPC status, never Google's free-form message, account
    // identifiers, token values or validation URLs from the response body.
    const parsed = googleErrorSchema.safeParse(await response.json().catch(() => undefined));
    const status = parsed.success ? `; ${parsed.data.error.status}` : "";
    throw new Error(`${description} failed (${response.status}${status}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
}
