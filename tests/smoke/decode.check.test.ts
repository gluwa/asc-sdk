import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AxiosError, AxiosHeaders } from 'axios';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDecodeCheck } from '../../src/bin/decode-check';
import { withRateLimitRetry } from '../../src/utils/rate-limit';

describe('decode check reporting', () => {
  let directory: string;
  let originalOutput: string | undefined;
  let originalSummary: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'decode-check-'));
    originalOutput = process.env.GITHUB_OUTPUT;
    originalSummary = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_OUTPUT = join(directory, 'output');
    process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary');
    writeFileSync(process.env.GITHUB_OUTPUT, '');
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, '');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('reports a completed sample', async () => {
    await expect(runDecodeCheck(async () => {})).resolves.toBe('complete');
    expect(readFileSync(join(directory, 'output'), 'utf8')).toBe('status=complete\n');
    expect(readFileSync(join(directory, 'summary'), 'utf8')).toContain('Decode check completed');
  });

  test('reports exhausted nested RPC throttling as incomplete', async () => {
    const error = Object.assign(new Error('missing revert data'), {
      code: 'CALL_EXCEPTION',
      info: { error: { code: -32029, message: 'Rate limit exceeded' } },
    });
    const operation = jest.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      runDecodeCheck(() => withRateLimitRetry('decodeEvmV1Transaction', operation, { numOfAttempts: 1 })),
    ).resolves.toBe('rate-limited');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(directory, 'output'), 'utf8')).toBe('status=rate-limited\n');
    expect(readFileSync(join(directory, 'summary'), 'utf8')).toContain('sample was not fully checked');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('::warning::Decode check incomplete'));
  });

  test('reports HTTP 429 as incomplete', async () => {
    const config = { headers: new AxiosHeaders() };
    const error = new AxiosError('request failed', 'ERR_BAD_RESPONSE', config, null, {
      status: 429,
      statusText: 'Too Many Requests',
      data: {},
      headers: new AxiosHeaders(),
      config,
    });

    await expect(
      runDecodeCheck(async () => {
        throw error;
      }),
    ).resolves.toBe('rate-limited');
  });

  test.each([
    'missing revert data',
    'execution reverted',
    'totalGas reaches or exceeds the single transaction gas limit',
    'proof lookups were skipped for blocks that are already attested',
    '0 files found to decode',
    'HTTP 503 Service Unavailable',
  ])('preserves a genuine failure: %s', async (message) => {
    const error = new Error(message);
    await expect(
      runDecodeCheck(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(readFileSync(join(directory, 'output'), 'utf8')).toBe('');
    expect(readFileSync(join(directory, 'summary'), 'utf8')).toBe('');
  });
});
