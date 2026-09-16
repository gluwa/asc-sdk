import { proofProvider, utils } from '@gluwa/asc-sdk';

async function example(): Promise<void> {
  // IMPORTANT: You have to define these values before executing this example
  const apiServerUrl = utils.env.getEnv('CREDITCOIN_PROOF_BUILDER_URL');
  const chainKey = parseInt(utils.env.getEnv('SOURCE_CHAIN_KEY'));
  const transactionHash = utils.env.getEnv('SOURCE_CHAIN_TXN_HASH');

  const apiProvider = new proofProvider.service.ProofBuilder(chainKey, apiServerUrl);
  const proofResult = await apiProvider.getProof(transactionHash);
  if (proofResult.success) {
    // Use the proof data
    console.log('Proof generated successfully:', proofResult.data);
  } else {
    throw new Error(`Proof generation failed: ${proofResult.error}`);
  }
}

example().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
