import axios from 'axios';
import { backOff, BackoffOptions } from 'exponential-backoff';

/**
 * JSON-RPC error code a Creditcoin RPC gateway returns once the caller runs out
 * of request quota. ethers wraps it in a `CALL_EXCEPTION` whose message is the
 * unhelpful 'missing revert data', so the real code has to be dug out of the
 * nested `info.error` payload.
 */
export const RPC_RATE_LIMIT_CODE = -32029;

/**
 * True when `error` is an RPC gateway (or an HTTP API) telling us to slow down,
 * rather than a genuine failure of the call itself.
 *
 * Throttling is transient, so these are the only errors worth retrying —
 * anything else must still propagate.
 *
 * @param error - the value caught from a provider or axios call
 *
 * @example
 * ```ts
 * try {
 *   await contract.getFunction('foo').estimateGas();
 * } catch (error) {
 *   if (!isRateLimitError(error)) throw error;
 * }
 * ```
 */
export function isRateLimitError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 429;
  }

  // ethers nests the provider's JSON-RPC error under `info.error`, but plain
  // provider errors also show up unwrapped; check both shapes.
  const candidates = [
    (error as { info?: { error?: unknown } })?.info?.error,
    (error as { error?: unknown })?.error,
    error,
  ];

  return candidates.some(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === RPC_RATE_LIMIT_CODE,
  );
}

export interface RateLimitRetryOptions {
  /** total attempts before giving up; delays double from 1s. Defaults to 7. */
  numOfAttempts?: number;
  /**
   * Called every time rate limiting is observed. Retrying only helps with
   * bursts — a caller that is *persistently* over quota should use this to slow
   * its overall pace down, e.g. via an {@link AdaptivePacer}.
   */
  onRateLimited?: () => void;
}

/**
 * Runs `operation`, backing off and retrying for as long as the far end reports
 * rate limiting. Any other error is thrown on the first attempt.
 *
 * Only wrap read-only, idempotent calls (`estimateGas`, `eth_call`, an HTTP
 * GET) — a retry re-issues the operation verbatim.
 *
 * @param label - name used in the retry log line, e.g. 'verifyAndEmit estimateGas'
 * @param operation - the call to run
 * @param opts - see {@link RateLimitRetryOptions}
 *
 * @example
 * ```ts
 * const estimate = await withRateLimitRetry('verifyAndEmit estimateGas', () =>
 *   contract.getFunction(fragment).estimateGas(...args),
 * );
 * ```
 */
export async function withRateLimitRetry<T>(
  label: string,
  operation: () => Promise<T>,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const { numOfAttempts = 7, onRateLimited } = opts;
  const backOffOptions = {
    delayFirstAttempt: false,
    jitter: 'full',
    numOfAttempts,
    startingDelay: 1000, // 1s, doubling: ~1+2+4+8+16+32s of patience over 7 attempts
    timeMultiple: 2,
    retry: (error: unknown, attempt: number) => {
      if (!isRateLimitError(error)) {
        return false;
      }
      onRateLimited?.();
      console.warn(`    ... rate limited on ${label}; retrying (attempt ${attempt})`);
      return true;
    },
  } as BackoffOptions;

  return backOff(operation, backOffOptions);
}

/**
 * Paces a loop of RPC calls, slowing down whenever the far end reports rate
 * limiting and never speeding back up.
 *
 * Retrying an individual call only rescues a burst. When a loop is
 * *persistently* asking for more than its quota — as `decode-blocks` is, at six
 * RPC requests per transaction — the only thing that helps is issuing fewer
 * requests per second, and the quota is not published anywhere, so the pace has
 * to be discovered by running into it.
 *
 * @example
 * ```ts
 * const pacer = new AdaptivePacer(500, 5000);
 * for (const item of items) {
 *   await pacer.wait();
 *   await withRateLimitRetry('call', () => rpcCall(item), { onRateLimited: () => pacer.slowDown() });
 * }
 * ```
 */
export class AdaptivePacer {
  private delayMs: number;

  /**
   * @param startingDelayMs - initial delay between iterations
   * @param maxDelayMs - delay ceiling, so a badly throttled run still finishes
   * @param factor - how sharply to back off on each rate limit observed
   */
  constructor(
    startingDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly factor: number = 1.5,
  ) {
    this.delayMs = startingDelayMs;
  }

  /** The delay currently applied between iterations. */
  public get currentDelayMs(): number {
    return this.delayMs;
  }

  /** Waits out the current delay. */
  public async wait(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  /**
   * Widens the delay after observing rate limiting, up to the ceiling.
   *
   * @returns the new delay, so callers can log the change
   */
  public slowDown(): number {
    const widened = Math.min(Math.round(this.delayMs * this.factor), this.maxDelayMs);
    const changed = widened !== this.delayMs;
    this.delayMs = widened;
    if (changed) {
      console.warn(`    ... pacing back to one transaction every ${this.delayMs}ms`);
    }

    return this.delayMs;
  }
}

/**
 * Caps the number of requests per second sent by any number of concurrent callers.
 *
 * {@link AdaptivePacer} spaces out the iterations of a single sequential loop,
 * so callers that wait on it at the same time all go at once. This limiter
 * gives each caller its own evenly spaced slot, in the order they ask, so a
 * block's worth of requests fired off with `Promise.all` still reaches the far
 * end at a steady rate instead of a burst that trips a per-second limit.
 *
 * @example
 * ```ts
 * const limiter = new RequestRateLimiter(25);
 * await Promise.all(
 *   txHashes.map(async (hash) => {
 *     await limiter.wait();
 *     return provider.send('eth_getTransactionByHash', [hash]);
 *   }),
 * );
 * ```
 */
export class RequestRateLimiter {
  private readonly intervalMs: number;
  private nextSlotMs = 0;

  /**
   * @param maxRequestsPerSecond - the most requests to allow in any second; 0 disables limiting
   */
  constructor(public readonly maxRequestsPerSecond: number) {
    if (!Number.isFinite(maxRequestsPerSecond) || maxRequestsPerSecond < 0) {
      throw new Error(`maxRequestsPerSecond must be a non-negative number, got ${maxRequestsPerSecond}`);
    }
    this.intervalMs = maxRequestsPerSecond > 0 ? 1000 / maxRequestsPerSecond : 0;
  }

  /** Whether this limiter holds requests back at all. */
  public get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** Waits until the caller may send its next request. */
  public async wait(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    const slot = Math.max(now, this.nextSlotMs);
    this.nextSlotMs = slot + this.intervalMs;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }
}
