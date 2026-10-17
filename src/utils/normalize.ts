export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Splits a comma-separated email list (e.g. `ADMIN_EMAILS`) into trimmed,
 * non-empty entries. Entries are validated by the env schema before use.
 */
export function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
