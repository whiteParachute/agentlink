export interface RetryPolicy {
  maxRetries: number;
}

export interface RetryState {
  retryCount: number;
  currentAttemptNo: number;
}

export type RetryTrigger = 'lease_expired' | 'run_timeout' | 'runner_failed' | 'manual_retry';

export interface RetryDecision {
  shouldRetry: boolean;
  nextAttemptNo?: number;
  nextRetryCount?: number;
  reason: 'retry_available' | 'retry_exhausted' | 'not_retryable';
}

export function decideRetry(
  trigger: RetryTrigger,
  state: RetryState,
  policy: RetryPolicy,
  options: { retryable?: boolean } = {},
): RetryDecision {
  if (trigger === 'runner_failed' && options.retryable !== true) {
    return { shouldRetry: false, reason: 'not_retryable' };
  }

  if (state.retryCount >= policy.maxRetries) {
    return { shouldRetry: false, reason: 'retry_exhausted' };
  }

  return {
    shouldRetry: true,
    nextAttemptNo: state.currentAttemptNo + 1,
    nextRetryCount: state.retryCount + 1,
    reason: 'retry_available',
  };
}
