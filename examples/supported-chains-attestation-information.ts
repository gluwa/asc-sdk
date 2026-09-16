import { chainInfo, utils } from '@gluwa/asc-sdk';
import { JsonRpcProvider } from 'ethers';

async function example(): Promise<void> {
  // IMPORTANT: You have to define these values before executing this example
  const creditcoinRpcUrl = utils.env.getEnv('CREDITCOIN_RPC_URL');
  const chainKey = parseInt(utils.env.getEnv('SOURCE_CHAIN_KEY'));
  const blockHeight = parseInt(utils.env.getEnv('SOURCE_CHAIN_BLOCK_HEIGHT'));

  const provider = new JsonRpcProvider(creditcoinRpcUrl);
  const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(provider);

  // Get supported chains
  const supportedChains = await chainInfoProvider.getSupportedChains();
  console.log('Supported chains:', supportedChains);

  if (!supportedChains.some((e) => e.chainKey === chainKey)) {
    throw new Error(`SOURCE_CHAIN_KEY=${chainKey} is not supported on ${creditcoinRpcUrl}`);
  }

  // Wait for a block to be attested
  await chainInfoProvider.waitUntilHeightAttested(chainKey, blockHeight);

  // Get continuity bounds for a specific block
  const bounds = await chainInfoProvider.getContinuityBounds(chainKey, blockHeight);
  console.log('Continuity bounds:', bounds);
}

example().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
