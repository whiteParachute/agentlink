import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_LEASE_STATUSES,
  STATE_TRANSITIONS,
  isActiveLeaseStatus,
  shouldCreateNewRunAttempt,
} from '../src/domain/status.js';
import { decideRetry } from '../src/domain/retry.js';

test('active lease statuses match Draft 3 definition', () => {
  assert.deepEqual([...ACTIVE_LEASE_STATUSES], ['ISSUED', 'ACKED', 'RENEWED']);
  assert.equal(isActiveLeaseStatus('ISSUED'), true);
  assert.equal(isActiveLeaseStatus('COMPLETED'), false);
});

test('state matrix includes four-entity recovery and revoke events', () => {
  const events = new Set(STATE_TRANSITIONS.map((transition) => transition.event));
  assert.equal(events.has('device_heartbeat_timeout'), true);
  assert.equal(events.has('device_revoke'), true);
  assert.equal(events.has('agentlet_recover_continue'), true);
  assert.equal(events.has('agentlet_recover_discard'), true);
  assert.equal(events.has('agentlet_ack_reject'), true);
});

test('retryable timeout events create a new run attempt', () => {
  assert.equal(shouldCreateNewRunAttempt('lease_expired_retryable'), true);
  assert.equal(shouldCreateNewRunAttempt('complete_failed_retryable'), true);
  assert.equal(shouldCreateNewRunAttempt('complete_failed_terminal'), false);
});

test('retry decision increments attempt and retry count until max_retries', () => {
  assert.deepEqual(decideRetry('lease_expired', { retryCount: 0, currentAttemptNo: 1 }, { maxRetries: 1 }), {
    shouldRetry: true,
    nextAttemptNo: 2,
    nextRetryCount: 1,
    reason: 'retry_available',
  });

  assert.deepEqual(decideRetry('lease_expired', { retryCount: 1, currentAttemptNo: 2 }, { maxRetries: 1 }), {
    shouldRetry: false,
    reason: 'retry_exhausted',
  });
});

test('non-retryable runner failure does not retry', () => {
  assert.deepEqual(decideRetry('runner_failed', { retryCount: 0, currentAttemptNo: 1 }, { maxRetries: 1 }, { retryable: false }), {
    shouldRetry: false,
    reason: 'not_retryable',
  });
});
