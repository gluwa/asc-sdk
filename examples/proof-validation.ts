import { blockProver, proofProvider, utils } from '@gluwa/asc-sdk';
import { JsonRpcProvider } from 'ethers';

async function example(): Promise<void> {
  // IMPORTANT: You have to define these values before executing this example
  const apiServerUrl = utils.env.getEnv('CREDITCOIN_PROOF_BUILDER_URL');
  const creditcoinRpcUrl = utils.env.getEnv('CREDITCOIN_RPC_URL');
  const chainKey = parseInt(utils.env.getEnv('SOURCE_CHAIN_KEY'));
  const transactionHash = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH');

  // First generate proof which we can validate later
  const apiProvider = new proofProvider.service.ProofBuilder(chainKey, apiServerUrl);
  const proofResult = await apiProvider.getProof(transactionHash);

  // verify the proof only if generated successfully
  if (proofResult.success && proofResult.data) {
    console.log('Proof generated successfully:', proofResult.data);
    const proofData = proofResult.data;

    const provider = new JsonRpcProvider(creditcoinRpcUrl);
    const prover = new blockProver.PrecompileBlockProver(provider);

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
