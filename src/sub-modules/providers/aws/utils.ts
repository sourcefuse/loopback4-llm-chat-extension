export function sanitizeFilenameForAwsConverse(filename: string): string {
  // Remove file extension if present
  const nameWithoutExt = filename.includes('.')
    ? filename.substring(0, filename.lastIndexOf('.'))
    : filename;

  // Keep only allowed characters: alphanumeric, whitespace, hyphens, parentheses, square brackets
  let sanitized = nameWithoutExt.replace(/[^a-zA-Z0-9\s\-()[\]]]/g, '');

  // Replace multiple consecutive whitespaces with single space
  sanitized = sanitized.replace(/\s+/g, ' ');

  // Trim leading/trailing whitespace
  sanitized = sanitized.trim();

  return sanitized;
}
