/**
 * Sanitise a filename for use as an AWS Bedrock Converse `document.name`.
 * Bedrock rejects document names containing characters outside
 * [alphanumeric, whitespace, hyphen, parentheses, square brackets] and names
 * with consecutive whitespace. Restored from the v2 (LangGraph) Bedrock file
 * path; in v3 the result is passed as the AI-SDK file part's `filename`, which
 * the Bedrock provider maps to the Converse document name.
 */
export function sanitizeFilenameForAwsConverse(filename: string): string {
  // Drop the extension (Bedrock derives format from the media type).
  const nameWithoutExt = filename.includes('.')
    ? filename.substring(0, filename.lastIndexOf('.'))
    : filename;

  // Keep only Bedrock-allowed characters.
  const allowedOnly = nameWithoutExt.replace(/[^a-zA-Z0-9\s\-()[\]]/g, '');

  // Collapse consecutive whitespace and trim.
  const sanitized = allowedOnly.replace(/\s+/g, ' ').trim();

  // Bedrock requires a non-empty name; fall back when sanitisation empties it.
  return sanitized || 'document';
}
