import bcrypt from 'bcryptjs';

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'welcome123', 'admin123', 'letmein123', 'iloveyou1', 'p@ssw0rd', 'passw0rd']);

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(pw: string, ctx: { email?: string; name?: string } = {}): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password is too long';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common';
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email address';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 3) return 'Use at least three of: lowercase, uppercase, numbers, symbols';
  return null;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
