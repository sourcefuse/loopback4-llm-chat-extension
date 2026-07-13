import {LLMStreamEvent} from './event.types';

/**
 * Shared coercion helpers for the Mastra tool wrappers. The tool `execute`
 * context (`requestContext`, workflow result objects) is loosely typed, so
 * each tool needs the same narrow casts: read a value as an object, as a
 * string, or as the SSE `eventWriter` bridged through RequestContext. Kept in
 * one place so the three tool wrappers don't each redefine them.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asEventWriter(
  value: unknown,
): ((e: LLMStreamEvent) => void) | undefined {
  return typeof value === 'function'
    ? (value as (e: LLMStreamEvent) => void)
    : undefined;
}

/**
 * Unwrap a Mastra workflow result that may be keyed under a matched branch arm.
 * After `.branch()`, the output lives under the branch step's id (e.g.
 * `save-dataset` or `failed`); pick the first non-empty arm, else the raw
 * result. Replaces a nested ternary repeated across the tool wrappers.
 */
export function pickBranchOutput(
  save: Record<string, unknown>,
  failed: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(save).length > 0) return save;
  if (Object.keys(failed).length > 0) return failed;
  return raw;
}
