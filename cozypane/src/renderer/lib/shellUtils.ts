/** POSIX single-quote shell escaping. Safe for use in terminal command strings. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
