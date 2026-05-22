/**
 * Parse `OTEL_SAMPLE_RATE` (or any sample-rate env var) into a number
 * in the [0, 1] range. Non-numeric or out-of-range values fall back to
 * the supplied default (defaults to 1.0 — sample everything). Prevents
 * the observability exporter from booting with `NaN` or a negative /
 * >1 probability that would silently break sampling.
 */
export function parseSampleRate(
  raw: string | undefined,
  fallback = 1.0,
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}
