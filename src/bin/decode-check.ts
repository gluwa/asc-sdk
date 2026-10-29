import { appendFileSync } from 'fs';
import { isRateLimitError } from '../utils/rate-limit';

/** Report exhausted throttling as incomplete; decoding, proof and gas errors still fail. */
export async function runDecodeCheck(check: () => Promise<void>): Promise<'complete' | 'rate-limited'> {
  let status: 'complete' | 'rate-limited' = 'complete';
  let summary = 'Decode check completed. See the log for proof coverage and gas measurements.';
  try {
    await check();
  } catch (error) {
    // The decoder retries each remote read before an error reaches here. Only
    // explicit RPC throttling or HTTP 429 makes the result inconclusive.
    if (!isRateLimitError(error)) throw error;
    status = 'rate-limited';
    summary = 'Decode check incomplete: RPC/API rate-limit retries exhausted. The sample was not fully checked.';
    console.warn(`::warning::${summary}`);
  }

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return status;
}
