import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatApplyReport, formatVerifyReport } from '../src/cli/reporting.ts';
import type { ApplyResult } from '../src/execution/types.ts';
import type { Plan } from '../src/planning/types.ts';

const hash = `0x${'11'.repeat(32)}`;
const address = '0x0000000000000000000000000000000000000001';

test('apply report shows transactions and ends with action and verification counts', () => {
  const result = {
    status: 'applied', transactionsSigned: 2,
    transactions: [
      { actionId: 'contract:vault', transactionHash: hash, signer: address, nonce: '7', wave: 1 },
      { actionId: 'call:configure', transactionHash: hash, signer: address, nonce: '8' },
    ],
    resources: [
      { id: 'contract:vault', action: 'deploy', outcome: 'applied', address, verification: { status: 'verified' } },
      { id: 'call:configure', action: 'call', outcome: 'applied', address, verification: { status: 'verified' } },
      { id: 'external:token', action: 'reuse', outcome: 'reused', address, verification: { status: 'verified' } },
    ],
  } as ApplyResult;
  const text = formatApplyReport(result);
  assert.match(text, /Transactions signed this run: 2/);
  assert.match(text, /contract:vault \(deploy\)\n    hash     0x/);
  assert.match(text, /    nonce    7\n    wave     1\n    address  0x/);
  assert.match(text, /call:configure \(call\)/);
  assert.match(text, /Apply complete! 1 deployed, 1 call executed, 1 reused; 3 verified\.\n$/);
  assert.doesNotMatch(text, /"resources"/);
});

test('stopped apply report distinguishes completed, failed, and pending resources', () => {
  const result = {
    status: 'stopped', transactionsSigned: 0, transactions: [],
    resources: [
      { id: 'contract:vault', action: 'deploy', outcome: 'applied', verification: { status: 'verified' } },
      { id: 'call:configure', action: 'call', outcome: 'failed' },
      { id: 'contract:other', action: 'deploy', outcome: 'pending' },
    ],
    stoppedAt: { code: 'postcondition', message: 'Getter differed', retryable: false },
  } as ApplyResult;
  assert.match(formatApplyReport(result), /Apply stopped \(postcondition\): Getter differed\. 1 deployed; 1 verified, 1 failed, 1 pending\.\n$/);
});

test('a resumed apply does not claim an earlier deployment happened in this run', () => {
  const result = {
    status: 'applied', transactionsSigned: 0, transactions: [],
    resources: [{ id: 'contract:vault', action: 'deploy', outcome: 'applied', resumed: true, verification: { status: 'verified' } }],
  } as ApplyResult;
  assert.match(formatApplyReport(result), /Apply complete! 1 previously completed; 1 verified\.\n$/);
});

test('verify report lists resource outcomes and reasons before its final count', () => {
  const observation = (status: string, reasons: string[] = [], missingProofs: string[] = []) => ({ status, reasons, missingProofs });
  const plan = {
    resources: [
      { id: 'contract:vault', address, action: 'reuse', observation: observation('verified') },
      { id: 'external:token', address, action: 'unverified', observation: observation('unverified', [], ['Getter could not be read.']) },
      { id: 'call:configure', address, action: 'conflict', observation: observation('conflict', ['Value differs.']) },
    ],
  } as Plan;
  const text = formatVerifyReport(plan);
  assert.match(text, /contract:vault: verified at 0x/);
  assert.match(text, /external:token: unverified at 0x[^\n]+\n    Getter could not be read\./);
  assert.match(text, /call:configure: conflict at 0x[^\n]+\n    Value differs\./);
  assert.match(text, /Verification incomplete: 1 verified, 1 unverified, 1 conflict\.\n$/);
});
