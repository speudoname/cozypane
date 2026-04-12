// Unified MIME type map — used by both preview.ts (static server) and
// filesystem.ts (binary file reading). Keyed by extension WITH leading dot.

export const MIME_TYPES: Record<string, string> = {
  // Web
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json',
  '.xml': 'application/xml', '.txt': 'text/plain', '.map': 'application/json',
  // Images
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
  // Fonts
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  // Video
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  // Audio
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  // Documents
  '.pdf': 'application/pdf',
};

/** Look up MIME type by extension (with or without leading dot). */
export function getMimeType(ext: string): string {
  const key = ext.startsWith('.') ? ext : `.${ext}`;
  return MIME_TYPES[key] || 'application/octet-stream';
}
