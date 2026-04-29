/**
 * Safely serialises an unknown value to a JSON string.
 * Returns a placeholder when the value is not serialisable.
 */
export function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, undefined, 2);
  } catch {
    return '[Unserializable args]';
  }
}
