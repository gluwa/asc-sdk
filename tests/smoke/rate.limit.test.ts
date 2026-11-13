import { describe, expect, jest, test } from '@jest/globals';
import { AxiosError, AxiosHeaders } from 'axios';
import { rateLimit } from '../../src/utils';

/**
 * The exact shape ethers produces for a throttled `eth_estimateGas` against
 * the Creditcoin RPC gateway, copied from a failing `decode-transactions` run
 * (GH Actions run 32726863341).
 */
function throttledEstimateGasError(): Error {
  return Object.assign(new Error('missing revert data'), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
    data: null,
    reason: null,
    shortMessage: 'missing revert data',
    info: {
      error: { code: -32029, message: 'Rate limit exceeded', data: {} },
      payload: { method: 'eth_estimateGas', params: [], id: 446, jsonrpc: '2.0' },
    },
  });
}

function axiosErrorWithStatus(status: number): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('request failed', 'ERR_BAD_RESPONSE', config, null, {
    status,
    statusText: '',
    data: {},
    headers: new AxiosHeaders(),
    config,
  });
}

describe('isRateLimitError', () => {
  test('detects -32029 nested in an ethers CALL_EXCEPTION', () => {
    expect(rateLimit.isRateLimitError(throttledEstimateGasError())).toBe(true);
  });

  test('detects -32029 on an unwrapped provider error', () => {
    expect(rateLimit.isRateLimitError({ error: { code: -32029, message: 'Rate limit exceeded' } })).toBe(true);
    expect(rateLimit.isRateLimitError({ code: -32029, message: 'Rate limit exceeded' })).toBe(true);
  });

  test('detects HTTP 429 from an axios call', () => {
    expect(rateLimit.isRateLimitError(axiosErrorWithStatus(429))).toBe(true);
  });

  test('does not treat other failures as rate limiting', () => {
    expect(rateLimit.isRateLimitError(new Error('execution reverted'))).toBe(false);
    expect(rateLimit.isRateLimitError({ info: { error: { code: -32000, message: 'execution reverted' } } })).toBe(
      false,
    );
    expect(rateLimit.isRateLimitError(axiosErrorWithStatus(422))).toBe(false);
    expect(rateLimit.isRateLimitError(null)).toBe(false);
    expect(rateLimit.isRateLimitError(undefined)).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  test('retries past rate limiting and returns the eventual result', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = jest
      .fn<() => Promise<bigint>>()
      .mockRejectedValueOnce(throttledEstimateGasError())
      .mockRejectedValueOnce(throttledEstimateGasError())
      .mockResolvedValue(860207n);

    // 3 attempts keeps the backoff (1s + 2s worst case) inside the test timeout
    await expect(rateLimit.withRateLimitRetry('estimateGas', operation, { numOfAttempts: 3 })).resolves.toBe(860207n);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test('gives up and rethrows once attempts run out', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = jest.fn<() => Promise<bigint>>().mockRejectedValue(throttledEstimateGasError());

    await expect(rateLimit.withRateLimitRetry('estimateGas', operation, { numOfAttempts: 2 })).rejects.toThrow(
      'missing revert data',
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('does not retry errors that are not rate limiting', async () => {
    const operation = jest.fn<() => Promise<bigint>>().mockRejectedValue(new Error('execution reverted'));

    await expect(rateLimit.withRateLimitRetry('estimateGas', operation)).rejects.toThrow('execution reverted');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('AdaptivePacer', () => {
  test('widens the gap each time throttling is seen, up to the ceiling', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const pacer = new rateLimit.AdaptivePacer(500, 2000);

    expect(pacer.currentDelayMs).toBe(500);
    expect(pacer.slowDown()).toBe(750);
    expect(pacer.slowDown()).toBe(1125);
    expect(pacer.slowDown()).toBe(1688);
    expect(pacer.slowDown()).toBe(2000);
    // pinned at the ceiling, so a throttled run still finishes
    expect(pacer.slowDown()).toBe(2000);
  });

  test('withRateLimitRetry reports throttling to the pacer', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const pacer = new rateLimit.AdaptivePacer(500, 5000);
    const operation = jest
      .fn<() => Promise<bigint>>()
      .mockRejectedValueOnce(throttledEstimateGasError())
      .mockResolvedValue(1n);

    await rateLimit.withRateLimitRetry('estimateGas', operation, {
      numOfAttempts: 2,
      onRateLimited: () => pacer.slowDown(),
    });

    expect(pacer.currentDelayMs).toBe(750);
  });

  test('waits out the current delay', async () => {
    const pacer = new rateLimit.AdaptivePacer(60, 60);
    const startedAt = process.hrtime.bigint();
    await pacer.wait();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    expect(elapsedMs).toBeGreaterThanOrEqual(50);
  });
});

describe('RequestRateLimiter', () => {
  const elapsedMsSince = (startedAt: bigint) => Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  test('does not hold requests back when disabled', async () => {
    const limiter = new rateLimit.RequestRateLimiter(0);
    expect(limiter.enabled).toBe(false);

    const startedAt = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 50 }, () => limiter.wait()));

    expect(elapsedMsSince(startedAt)).toBeLessThan(50);
  });

  test('spaces concurrent callers evenly instead of letting them burst', async () => {
    // 20 req/s => one slot every 50ms; the 5th caller gets the slot 200ms in.
    const limiter = new rateLimit.RequestRateLimiter(20);
    expect(limiter.enabled).toBe(true);

    const startedAt = process.hrtime.bigint();
    const releasedAtMs = await Promise.all(
      Array.from({ length: 5 }, async () => {
        await limiter.wait();
        return elapsedMsSince(startedAt);
      }),
    );

    expect(releasedAtMs[0]).toBeLessThan(25);
    // timers can fire a hair early, so allow a few ms of slack on the lower bound
    expect(releasedAtMs[4]).toBeGreaterThanOrEqual(195);
    for (let i = 1; i < releasedAtMs.length; i++) {
      expect(releasedAtMs[i]).toBeGreaterThanOrEqual(releasedAtMs[i - 1]);
    }
  });

  test('rejects a negative or non-numeric rate', () => {
    expect(() => new rateLimit.RequestRateLimiter(-1)).toThrow('non-negative');
    expect(() => new rateLimit.RequestRateLimiter(Number('abc'))).toThrow('non-negative');
  });
});
