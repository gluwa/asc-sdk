import axios from 'axios';
import { readdirSync, readFileSync, statSync } from 'fs';
import { glob } from 'glob';
import { BaseContract, Contract, Wallet, WebSocketProvider } from 'ethers';
import type { InterfaceAbi } from 'ethers';
import { abiEncode } from '../encoding/abi';
import { getTransactionWithRaw } from '../encoding';
import { decoder, health, rateLimit } from '../utils';
import EvmV1DecoderABI from '../utils/evmV1DecoderAbi.json';
import { blockProver, chainInfo, proofProvider } from '../';
import { blockNumberFromPath, isExpectedProofSkip, ProofSkipReason, sampleEvenly } from './decode-policy';

type ProofLookup =
  | { response: proofProvider.ContinuityResponse; skipReason: null }
  | { response: null; skipReason: ProofSkipReason };

async function getProofForTxn(
  apiUrl: string,
  chainKey: number,
  txn: string,
  pacer: rateLimit.AdaptivePacer,
): Promise<ProofLookup> {
  const url = `${apiUrl}/api/v1/proof-by-tx/${chainKey}/${txn}`;
  try {
    // NOTE: throws an exception in case of errors
    const response = await rateLimit.withRateLimitRetry('proof-by-tx', () => axios.get(url), {
      onRateLimited: () => pacer.slowDown(),
    });
    return { response: response.data as proofProvider.ContinuityResponse, skipReason: null };
  } catch (error) {
    // The prover returns HTTP 422 with code 'EmptyBlockTxProof' for blocks
    // that contain no transactions; there is no tx proof to verify, so we
    // treat this as a skip rather than a hard failure. Any other error is
    // re-thrown so genuine problems still surface and fail the run.
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 422 &&
      (error.response?.data?.code === 'EmptyBlockTxProof' || error.response?.data?.code === 'BlockNotReady')
    ) {
      return { response: null, skipReason: error.response.data.code as ProofSkipReason };
    }

    // usually means block is within the source chain's reorg-protection window and is not yet confirmed.
    // skip it b/c this workflow usually operates on latest blocks and we don't want to fail
    // b/c of that
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 404 &&
      error.response?.data?.code === 'BlockNotOnSourceChain'
    ) {
      return { response: null, skipReason: 'BlockNotOnSourceChain' };
    }

    throw error;
  }
}

async function decodeFromDisk(
  pathToTxn: string,
  decodeContract: Contract,
  proverPrecompileWithSigner: BaseContract,
  proverBaseUrl: string,
  chainKey: number,
  pacer: rateLimit.AdaptivePacer,
  blockGasLimit: bigint,
): Promise<ProofSkipReason | null> {
  // `blockGasLimit` is the hard ceiling; 70% is the block budget (see commit log + linked Slack
  // thread); a third is the per-transaction tripwire, ahead of per-transaction gas limits landing
  // on chain. The tripwire equals the 25M it replaces, derived so it cannot go stale.
  const totalGasThreshold = (blockGasLimit * 7n) / 10n;
  const singleTxnGasLimit = blockGasLimit / 3n;
  const verifyAndEmitSingleFragment =
    'verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))';

  const pathComponents = pathToTxn.replace('.txt', '').split('/');
  const txHash = pathComponents[pathComponents.length - 1];

  console.log(`... get proof for source txn ${txHash}`);
  await pacer.wait(); // rate-limit

  let gasForVerification = 0n;
  const { response: proofData, skipReason } = await getProofForTxn(proverBaseUrl, chainKey, txHash, pacer);
  if (proofData !== null) {
    const estimate = await rateLimit.withRateLimitRetry(
      'verifyAndEmit estimateGas',
      () =>
        proverPrecompileWithSigner
          .getFunction(verifyAndEmitSingleFragment)
          .estimateGas(
            proofData.chainKey,
            proofData.headerNumber,
            proofData.txBytes,
            proofData.merkleProof,
            proofData.continuityProof,
          ),
      { onRateLimited: () => pacer.slowDown() },
    );
    gasForVerification = BigInt(estimate);
  }
  // Always say *why* a verification was skipped. A silent `gasForVerification=0`
  // hid a dead prover for days: every proof lookup was being skipped and the run
  // still reported the gas check as passing.
  console.log(
    skipReason === null
      ? `    ... gasForVerification=${gasForVerification}`
      : `    ... gasForVerification skipped: prover returned ${skipReason}`,
  );

  // Check each component against the ceiling as it lands, so an unsubmittable estimate is
  // attributed to verification or decoding rather than only to the combined total.
  if (gasForVerification > blockGasLimit) {
    throw new Error(
      `gasForVerification ${gasForVerification} exceeds the ${blockGasLimit} block gas limit; unsubmittable, failing run`,
    );
  }

  const encodedData = readFileSync(pathToTxn, {
    encoding: 'utf8',
    flag: 'r',
  }).trim();

  const decoded = await rateLimit.withRateLimitRetry(
    'decodeEvmV1Transaction',
    () =>
      decoder.decodeEvmV1Transaction(encodedData, decodeContract, {
        trackGas: true,
      }),
    { onRateLimited: () => pacer.slowDown() },
  );
  const gasForDecoding = decoded.gasUsed ?? BigInt(0);
  console.log(`     decoded as type ${decoded.type}, gasForDecoding=${gasForDecoding}`);
  if (gasForDecoding > blockGasLimit) {
    throw new Error(
      `gasForDecoding ${gasForDecoding} exceeds the ${blockGasLimit} block gas limit; unsubmittable, failing run`,
    );
  }

  // 10% safety margin on the raw estimates. Most severe tier first, so an unsubmittable proof
  // does not report as merely over budget.
  const totalGas = ((gasForVerification + gasForDecoding) * 11n) / 10n;
  console.log(`    ... totalGas (with 10% margin)=${totalGas} (threshold=${totalGasThreshold})`);
  if (totalGas > blockGasLimit) {
    throw new Error(`totalGas ${totalGas} exceeds the ${blockGasLimit} block gas limit; unsubmittable, failing run`);
  }
  if (totalGas >= totalGasThreshold) {
    throw new Error(
      `totalGas ${totalGas} reaches or exceeds 70% of the ${blockGasLimit} block gas limit (${totalGasThreshold}); failing run`,
    );
  }
  if (totalGas >= singleTxnGasLimit) {
    throw new Error(
      `totalGas ${totalGas} reaches or exceeds the per-transaction tripwire (${singleTxnGasLimit}, a third of the ${blockGasLimit} block gas limit); failing run`,
    );
  }

  return skipReason;
}

/**
 * Blocks newer than the latest attestation have no proof yet, and this workflow
 * deliberately encodes the newest blocks it can find, so most skips are
 * expected — see {@link isExpectedProofSkip}. Skipping proofs for blocks that
 * *are* attested is the symptom worth failing on: the proof should exist, so
 * the prover is not doing its job and the verification-gas check is only
 * pretending to run. Fail once that rate stays high over a conclusive sample.
 */
const MAX_UNEXPECTED_SKIP_RATE = 0.9;
const MIN_SKIP_SAMPLE = 50;

/**
 * How long a read of the attested height stays usable. Attestation only moves
 * forward, so a stale (lower) height merely classifies borderline skips as
 * expected — the safe direction to err in.
 */
const ATTESTED_HEIGHT_TTL_MS = 60_000;

/**
 * Pacing bounds, in milliseconds, for the gap between transactions. Each
 * transaction costs about six RPC requests (three decoder calls, each paired
 * with an `estimateGas` by `trackGas`), and the devnet gateway's quota sits
 * below what that adds up to at the old fixed 500ms — so the gap starts there
 * and widens on its own whenever throttling shows up. Together with the
 * transaction cap the ceiling bounds the runtime: at the widest pace, 150
 * transactions take about six minutes.
 */
const STARTING_PACE_MS = 500;
const MAX_PACE_MS = 2_500;

async function decodeBlocks(
  creditcoinUrl: string,
  proverUrl: string,
  decoderLibraryAddress: string,
  pathToStore: string,
  chainKey: number,
  maxTransactions: number,
): Promise<void> {
  const creditcoinWs = new WebSocketProvider(creditcoinUrl);
  const decodeContract = new Contract(decoderLibraryAddress, EvmV1DecoderABI as InterfaceAbi, creditcoinWs);

  const proverPrecompile = new blockProver.PrecompileBlockProver(creditcoinWs);
  const proverPrecompileWithSigner = proverPrecompile.blockProverContract.connect(
    Wallet.createRandom().connect(creditcoinWs),
  );

  // Read the block gas limit from chain rather than hard-coding it, so the checks track the
  // runtime's `BlockGasLimit`. Constant per runtime, so fetched once. This is the hard ceiling:
  // pallet-ethereum rejects a tx above it, though estimateGas can still report higher.
  const latestBlock = await creditcoinWs.getBlock('finalized');
  if (latestBlock === null || latestBlock.gasLimit <= 0n) {
    throw new Error('could not read EVM block gas limit from chain');
  }
  const blockGasLimit = latestBlock.gasLimit;
  console.log(
    `INFO: on-chain EVM block gas limit = ${blockGasLimit} (hard ceiling), 70% threshold = ${(blockGasLimit * 7n) / 10n}, per-txn tripwire = ${blockGasLimit / 3n}`,
  );

  const encodedFiles = await glob('*/**.txt', { cwd: pathToStore, absolute: true });
  encodedFiles.sort();
  console.log(`INFO: found ${encodedFiles.length} transactions to decode`);

  if (encodedFiles.length === 0) {
    throw new Error('0 files found to decode. Something is wrong. Please investigate');
  }

  // Decoding every encoded transaction is what pushes this job over the RPC
  // quota: the encode step happily produces thousands of them, and at six
  // requests each there is no pace that gets through them all in CI. Sample
  // instead, spread across every block encoded, so each run checks a bounded
  // slice and consecutive runs cover different transactions.
  const txnFiles = sampleEvenly(encodedFiles, maxTransactions);
  const numFiles = txnFiles.length;
  if (numFiles < encodedFiles.length) {
    console.log(`INFO: decoding a sample of ${numFiles} of them, spread across all encoded blocks`);
  }

  const pacer = new rateLimit.AdaptivePacer(STARTING_PACE_MS, MAX_PACE_MS);

  // read lazily (only when something is skipped) and cached, so classifying
  // skips costs one RPC call a minute rather than one per transaction
  const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(creditcoinWs);
  let attestedHeight: { value: number | null; readAt: number } | null = null;
  const readAttestedHeight = async (): Promise<number | null> => {
    if (attestedHeight !== null && Date.now() - attestedHeight.readAt < ATTESTED_HEIGHT_TTL_MS) {
      return attestedHeight.value;
    }

    try {
      const heightHash = await rateLimit.withRateLimitRetry(
        'latest attested height',
        () => chainInfoProvider.getLatestAttestedHeightAndHash(chainKey),
        { onRateLimited: () => pacer.slowDown() },
      );
      attestedHeight = { value: heightHash.exists ? heightHash.height : null, readAt: Date.now() };
    } catch (error) {
      // not being able to read the height is not a reason to fail the run; it
      // only means skips cannot be classified for the next minute
      console.warn(`    ... could not read the latest attested height: ${error}`);
      attestedHeight = { value: null, readAt: Date.now() };
    }

    return attestedHeight.value;
  };

  const skipReasons = new Map<ProofSkipReason, number>();
  let expectedSkips = 0;
  let unexpectedSkips = 0;

  for (const [idx, txFile] of txnFiles.entries()) {
    console.log(`>>>> ${idx}/${numFiles} decoding ${txFile}`);
    const skipReason = await decodeFromDisk(
      txFile,
      decodeContract,
      proverPrecompileWithSigner,
      proverUrl,
      chainKey,
      pacer,
      blockGasLimit,
    );

    if (skipReason !== null) {
      skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);

      const blockNumber = blockNumberFromPath(txFile);
      const latestAttested = await readAttestedHeight();
      if (isExpectedProofSkip(skipReason, blockNumber, latestAttested)) {
        expectedSkips += 1;
      } else {
        unexpectedSkips += 1;
        console.warn(
          `    ... block ${blockNumber} is attested (latest attested height is ${latestAttested}) but the prover returned ${skipReason}`,
        );
      }
    }

    const attempted = idx + 1;
    if (health.skipRateExceeded(unexpectedSkips, attempted, MAX_UNEXPECTED_SKIP_RATE, MIN_SKIP_SAMPLE)) {
      const tally = [...skipReasons].map(([reason, count]) => `${reason}=${count}`).join(', ');
      throw new Error(
        `${unexpectedSkips}/${attempted} proof lookups were skipped for blocks that are already attested (${tally}); ` +
          `verification gas is not being checked at all. The prover is likely unhealthy ` +
          `— check ${proverUrl}/api/v1/health. Failing run`,
      );
    }
  }

  const skipped = expectedSkips + unexpectedSkips;
  if (skipped > 0) {
    const tally = [...skipReasons].map(([reason, count]) => `${reason}=${count}`).join(', ');
    console.log(
      `INFO: skipped verification for ${skipped}/${numFiles} transactions ` +
        `(${tally}; ${unexpectedSkips} of them for blocks that were already attested)`,
    );
  }
  // Losing the verification-gas check entirely is not a script failure, but it
  // does mean this run only measured decoding. It happens when every block
  // encoded is newer than the latest attestation, i.e. the encode window is
  // shorter than the time attestation lags the source chain.
  if (skipped === numFiles) {
    console.warn(
      `WARNING: verification gas was never measured — all ${numFiles} transactions were skipped. ` +
        `Every encoded block is newer than the latest attested height, so encode a longer window ` +
        `(or wait for attestation) if this run is meant to exercise verifyAndEmit.`,
    );
  }
  console.log(`DONE (final pace: one transaction every ${pacer.currentDelayMs}ms)`);
  process.exit(0);
}

if (process.argv.length < 5) {
  console.error(
    'node dist/bin/decode-blocks.js <ws://creditcoinRpcUrl> <proverUrl> <evmV1DecoderAddress> <pathToStore> <chainKey> [maxTransactions]',
  );
  process.exit(1);
}

const rpcUrl = process.argv[2] || 'ws://127.0.0.1:9944';
const proverUrl = process.argv[3];
const evmV1DecoderAddress = process.argv[4];
const pathToStore = process.argv[5];
const chainKey = parseInt(process.argv[6]);
// optional: 0 (the default) decodes everything, which is only viable off CI
const maxTransactions = parseInt(process.argv[7]) || 0;

decodeBlocks(rpcUrl, proverUrl, evmV1DecoderAddress, pathToStore, chainKey, maxTransactions).catch((reason) => {
  console.error(reason);
  process.exit(1);
});
