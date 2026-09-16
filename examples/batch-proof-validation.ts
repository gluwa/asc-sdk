import { blockProver, proofProvider, utils } from '@gluwa/asc-sdk';
import { JsonRpcProvider } from 'ethers';

async function example(): Promise<void> {
  // IMPORTANT: You have to define these values before executing this example
  const apiServerUrl = utils.env.getEnv('CREDITCOIN_PROOF_BUILDER_URL');
  const creditcoinRpcUrl = utils.env.getEnv('CREDITCOIN_RPC_URL');
  const chainKey = parseInt(utils.env.getEnv('SOURCE_CHAIN_KEY'));

  // 3 transactions
  const transactionHash1 = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH');
  const transactionHash2 = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH_2');
  const transactionHash3 = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH_3');

  const apiProvider = new proofProvider.service.ProofBuilder(chainKey, apiServerUrl);

  // First generate a shared proof for all 3 transactions, which we can validate later
  const proofResult = await apiProvider.getBatchProof([transactionHash1, transactionHash2, transactionHash3]);

  // verify the proof only if generated successfully
  if (proofResult.success && proofResult.data) {
    console.log('Proof generated successfully:', proofResult.data);
    const proofData = proofResult.data;

    // Prepare batch proof data for verification by organizing it into arrays of headers, txBytes, and merkleProofs
    // corresponding to each transaction in the batch
    const headers = [];
    const txBytes = [];
    const merkleProofs = [];
    for (const [headerNumber, proofsMap] of proofData.merkleProofs.entries()) {
      for (const [_txIndex, proofEntry] of proofsMap.entries()) {
        headers.push(headerNumber);
        txBytes.push(proofEntry.txBytes);
        merkleProofs.push(proofEntry.merkleProof);
      }
    }

    const provider = new JsonRpcProvider(creditcoinRpcUrl);
    const prover = new blockProver.PrecompileBlockProver(provider);

    // Verify the proof on-chain
    const verificationResult = await prover.verifyBatch(
      proofData.chainKey,
      headers,
      txBytes,
      merkleProofs,
      proofData.continuityProof,
    );

    console.log('Proof verification:', verificationResult ? 'SUCCESS' : 'FAILED');
    if (!verificationResult) {
      throw new Error('proof verification failed');
    }
  } else {
    throw new Error(`Proof generation failed: ${proofResult.error}`);
  }
}

example().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
