import { createHmac } from 'node:crypto';

export function normalizeEmail(email: string): string {
  const normalized = email.trim().normalize('NFC').toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('INVALID_EMAIL');
  // Deliberately preserve dots and +suffixes; provider-specific aliases are not proof of identity.
  return normalized;
}

export function emailIdentity(email: string, secret: string): string {
  if (secret.length < 32) throw new Error('IDENTITY_SECRET_TOO_SHORT');
  return createHmac('sha256', secret).update(`email:v1:${normalizeEmail(email)}`).digest('hex');
}

export function resolveIdentity(candidates: readonly string[]): { personId: string | null; state: 'resolved' | 'unresolved' | 'ambiguous' } {
  const ids = [...new Set(candidates)];
  if (ids.length === 1) return { personId: ids[0], state: 'resolved' };
  return { personId: null, state: ids.length > 1 ? 'ambiguous' : 'unresolved' };
}
