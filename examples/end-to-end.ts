import { chainInfo, blockProver, proofProvider, utils } from '@gluwa/asc-sdk';
import { JsonRpcProvider } from 'ethers';

async function example(): Promise<void> {
  // IMPORTANT: You have to define these values before executing this example
  const apiServerUrl = utils.env.getEnv('CREDITCOIN_PROOF_BUILDER_URL');
  const creditcoinRpcUrl = utils.env.getEnv('CREDITCOIN_RPC_URL');
  const chainKey = parseInt(utils.env.getEnv('SOURCE_CHAIN_KEY'));
  const txHash = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH');
  const txHeight = parseInt(utils.env.getEnv('SOURCE_CHAIN_BLOCK_HEIGHT'));

  // Setup Creditcoin components
  const creditcoinProvider = new JsonRpcProvider(creditcoinRpcUrl);
  const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(creditcoinProvider);
  const prover = new blockProver.PrecompileBlockProver(creditcoinProvider);

  // Before generating a proof we have to wait for the block containing the transaction
  // we want to prove, to be attested on the creditcoin chain
  await chainInfoProvider.waitUntilHeightAttested(chainKey, txHeight);

  // Once the block is attested we can request the proof from the proof builder service
  const apiProvider = new proofProvider.service.ProofBuilder(chainKey, apiServerUrl);
  const proofResult = await apiProvider.getProof(txHash);

  if (proofResult.success && proofResult.data) {
    const proofData = proofResult.data;

    // Verify the proof on-chain
    const verificationResult = await prover.verifySingle(
      proofData.chainKey,
      proofData.headerNumber,
      proofData.txBytes,
      proofData.merkleProof,
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
