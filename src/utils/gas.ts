import { Contract, JsonRpcApiProvider } from 'ethers';

/**
 * Estimates gas for a contract call and returns a gas limit with a buffer
 * applied. When gas estimation fails (e.g. due to known issues with
 * precompiles where `pallet-evm` does not propagate revert reasons during
 * estimation mode), falls back to a heuristic based on the continuity
 * proof size, matching the Rust logic.
 *
 * Ported from gluwa/attestcoin-protocol-examples#77
 * (decode-testing/submit_decode_query.ts).
 */
export async function computeGasLimit(
  provider: JsonRpcApiProvider,
  contract: Contract,
  data: string,
  from: string,
  continuityLength: number,
): Promise<bigint> {
  const GAS_BUFFER_MULTIPLIER = 135; // 100% + 35% buffer
  // Estimate gas and add buffer
  console.log('⏳ Estimating gas...');

  let gasLimit;
  try {
    const estimatedGas = await provider.estimateGas({
      to: contract.getAddress(),
      data,
      from,
    });
    gasLimit = (estimatedGas * BigInt(GAS_BUFFER_MULTIPLIER)) / BigInt(100);
    console.log(`   Estimated gas: ${estimatedGas.toString()}, Gas limit with buffer: ${gasLimit.toString()}`);
  } catch (error: any) {
    // Gas estimation can fail even when the call would succeed
    // This is a known issue with precompiles - pallet-evm doesn't always
    // properly propagate revert reasons during estimation mode
    // Calculate a reasonable estimate based on continuity proof size (matching Rust logic)
    // Base: 21000 (tx) + ~5000 per continuity block + ~10000 for merkle + overhead
    const calculatedGas = 21000 + continuityLength * 5000 + 20000;
    console.warn(`   Gas estimation failed: ${error.shortMessage}`);
    console.log(
      `   Using calculated gas limit based on proof size: ${calculatedGas} (${continuityLength} continuity blocks)`,
    );
    gasLimit = BigInt(calculatedGas);
  }

  return gasLimit;
}

/**
 * Maximum block gas cap used to compute relative gas usage. Currently set
 * to 75,000,000 (75M gas), the cap used on Creditcoin.
 */
export const MAX_GAS_CAP = BigInt(75_000_000);

/**
 * Expresses `actualGas` as a percentage (0..100) of {@link MAX_GAS_CAP}.
 * The result is clamped to `[0, 100]`.
 */
export function gasAsPercentageOfMax(actualGas: bigint): number {
  if (actualGas <= BigInt(0)) return 0;
  if (actualGas >= MAX_GAS_CAP) return 100;
  // Scale to basis points first to preserve two decimals of precision
  // before converting to a Number.
  const bps = (actualGas * BigInt(10_000)) / MAX_GAS_CAP;
  return Number(bps) / 100;
}
