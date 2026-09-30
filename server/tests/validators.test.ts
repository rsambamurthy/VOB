import { describe, expect, test } from 'vitest';
import { validators, gstinCheckChar, crossFieldChecks } from '../src/lib/validators.js';
import { passwordProblem } from '../src/lib/password.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';

describe('identifier validators', () => {
  test('GSTIN checksum', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(validators.gstin('27AAPFU0939F1ZV')).toBeNull();
    expect(validators.gstin('27AAPFU0939F1ZA')).toMatch(/checksum/);
  });
  test('PAN / TAN / IFSC / SWIFT', () => {
    expect(validators.pan('AAPFU0939F')).toBeNull();
    expect(validators.pan('AAPXU0939F')).not.toBeNull();
    expect(validators.tan('MUMA12345B')).toBeNull();
    expect(validators.ifsc('HDFC0001234')).toBeNull();
    expect(validators.ifsc('HDFC1001234')).not.toBeNull();
    expect(validators.swift('DEUTDEFF')).toBeNull();
    expect(validators.swift('DE61300800000212895000')).not.toBeNull();
  });
  test('IBAN mod-97', () => {
    expect(validators.iban('DE61300800000212895000')).toBeNull();
    expect(validators.iban('DE61300800000212895001')).not.toBeNull();
  });
  test('GSTIN/PAN cross-check', () => {
    expect(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' } })).toHaveLength(0);
    expect(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'ABCPD1234E' } })).toHaveLength(1);
  });
});

describe('security helpers', () => {
  test('password policy', () => {
    expect(passwordProblem('short')).toMatch(/10/);
    expect(passwordProblem('alllowercaseletters')).toMatch(/three/);
    expect(passwordProblem('Anita.rao2026!', { email: 'anita.rao@x.com' })).toMatch(/email/);
    expect(passwordProblem('Correct-Horse-7')).toBeNull();
  });
  test('encryption round-trip and tamper detection', () => {
    const c = encrypt('JBSWY3DPEHPK3PXP');
    expect(decrypt(c)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, ct] = c.split('.');
    expect(() => decrypt([iv, tag, Buffer.from('x' + ct, 'base64').toString('base64')].join('.'))).toThrow();
  });
});
