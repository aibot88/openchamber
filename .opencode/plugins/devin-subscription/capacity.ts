// A capacity rejection means the requested model is saturated upstream: only
// waiting clears it, so the session may retry on a bounded schedule. Quota and
// policy refusals are a different class and never map here. The marker text is
// authored locally, so it can match session errors without echoing upstream
// content.
const CODES = new Set(["unavailable", "resource_exhausted"]);
const STATUSES = new Set([429, 503]);
const DELAYS = [15_000, 30_000, 60_000, 120_000];
const MARKER = "capacity is busy";

export const busyCode = (code: string | undefined): code is string => code !== undefined && CODES.has(code);
export const busyStatus = (status: number) => STATUSES.has(status);
export const busyMessage = (detail: string) => `Devin rejected the request (${detail}): model ${MARKER}, and only waiting clears it.`;
export const isBusy = (text: string) => text.includes(MARKER);
// attempt counts retries already decided. Whether OpenCode numbers the first
// failure 0 or 1, the schedule stays bounded at five waits at most.
export const busyRetry = (attempt: number): { retry: true; delay: number } | { retry: false } =>
  attempt <= DELAYS.length ? { retry: true, delay: DELAYS[Math.min(Math.max(attempt, 1), DELAYS.length) - 1] } : { retry: false };
