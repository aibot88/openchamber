import { formatCompactNumber } from '@/lib/numberFormat';

type TokenLabels = { context: string; output: string; unknownContext: string; unknownOutput: string };

export function providerModelTokenSummary(
  limit: { context?: number; output?: number } | undefined,
  labels: TokenLabels,
  compact = false,
): string {
  const format = (value: number | undefined, unit: string, unknown: string) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return compact ? `— ${unit}` : unknown;
    const formatted = formatCompactNumber(value);
    return `${formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted} ${unit}`;
  };
  return [format(limit?.context, labels.context, labels.unknownContext),
    format(limit?.output, labels.output, labels.unknownOutput)].join(' · ');
}
