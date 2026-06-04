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
