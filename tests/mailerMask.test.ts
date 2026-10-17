import { describe, expect, it } from 'vitest';
import { maskEmail } from '../src/lib/mailer.js';

describe('maskEmail (log PII minimisation)', () => {
  it('keeps the first character and the domain, masks the rest of the local part', () => {
    expect(maskEmail('customer@example.com')).toBe('c*******@example.com');
  });

  it('never returns the original local part for multi-character addresses', () => {
    const masked = maskEmail('aarav.sharma@gmail.com');
    expect(masked.endsWith('@gmail.com')).toBe(true);
    expect(masked.startsWith('a')).toBe(true);
    expect(masked).not.toContain('aarav.sharma');
  });

  it('handles single-character local parts without leaking more than one char', () => {
    expect(maskEmail('a@x.io')).toBe('a*@x.io');
  });

  it('degrades safely for input without a usable @ (no crash, no echo)', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});
