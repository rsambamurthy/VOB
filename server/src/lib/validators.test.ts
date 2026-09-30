import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validators, gstinCheckChar, crossFieldChecks } from './validators.js';

test('GSTIN checksum', () => {
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
  assert.equal(validators.gstin('27AAPFU0939F1ZV'), null);
  assert.notEqual(validators.gstin('27AAPFU0939F1ZA'), null);
});
test('PAN / TAN / IFSC / SWIFT', () => {
  assert.equal(validators.pan('AAPFU0939F'), null);
  assert.notEqual(validators.pan('AAPXU0939F'), null);
  assert.equal(validators.tan('MUMA12345B'), null);
  assert.equal(validators.ifsc('HDFC0001234'), null);
  assert.notEqual(validators.ifsc('HDFC1001234'), null);
  assert.equal(validators.swift('DEUTDEFF'), null);
  assert.notEqual(validators.swift('DE61300800000212895000'), null); // IBAN stored as BIC in the sample ERP data
});
test('IBAN mod-97', () => {
  assert.equal(validators.iban('DE61300800000212895000'), null);
  assert.equal(validators.iban('DE20250700700013524400'), null);
  assert.notEqual(validators.iban('DE61300800000212895001'), null);
});
test('GSTIN/PAN cross-check', () => {
  assert.equal(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' } }).length, 0);
  assert.equal(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'ABCPD1234E' } }).length, 1);
});
