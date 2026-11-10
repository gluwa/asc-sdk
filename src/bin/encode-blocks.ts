import { mkdirSync, writeFileSync } from 'fs';
import { Block, WebSocketProvider, TransactionReceipt } from 'ethers';
import { abiEncode } from '../encoding/abi';
import { getTransactionWithRaw } from '../encoding';
import { bytesInHexString } from '../utils/hex';

// Maximum discovered size of ABI-encoded transaction data, in bytes.
// Derived from the largest observed successfully-encoded transactions on mainnet:
//   block 25631442, tx 0xb4548765a21c0aad6742e6198b4b28c6e42f896c9419890d0f4b67766d63e7c6 (encodedSize=530336)
//   block 25551628, tx 0x181611bff5f83dcf85cc45e06a453ee79a4ca1a697a1316030e655901c71bee8 <- MAX_ENCODED_SIZE (503776, largest that fits)
//   block 25551622, tx 0x296d83e8a0db263ad06422be8c6bd426c70785cc7c4f2b0b559eec5586e9da86
//   block 25238768, tx 0x01ca130bf04e636d26ebdf0f6256a99894a6b474d4c016af74849c6a7572928d
//   block 25238750, tx 0x343b91c47944693ed1cdf3c979bd7722ed9284320ff6069bcfd46c109d9c4199
//   block 25238749, tx 0x5f60979ee18aba3f76122574e987f974fb1d7bacc372666f4b3f647236d54794
//   block 25238746, tx 0xf2641f3bd13a111169c007205b3d1e7188201df3ae041991d2e1e3745ed1fb2d
const MAX_ENCODED_SIZE = 503776;

/**
 * Gets all transaction receipts for a given block using regular Infura/compatible RPC format.
 * Uses hexadecimal block number format (e.g., "0x1a2b3c").
 *
 * @param rpc - The ethers JsonRpcApiProvider instance
 * @param block - The block to get receipts for
 * @returns Array of transaction receipts for the block
 */
async function getBlockReceipts(rpc: WebSocketProvider, block: Block): Promise<TransactionReceipt[]> {
  // Regular Infura/compatible RPC takes block number as hexadecimal string
  const finalBlockNumber = `0x${block.number.toString(16)}`;

  // Call the RPC method to get all receipts for the block
  const receiptsRaw: Array<any> = await rpc.send('eth_getBlockReceipts', [finalBlockNumber]);

  // Wrap raw receipts into proper TransactionReceipt objects
  const receipts = receiptsRaw.map((r) => {
    const receipt = rpc._wrapTransactionReceipt(r, rpc._network);
    return receipt;
  });

  return receipts;
}

// cost 80 or 160 credits depnding on arguments
async function encodeTransaction(
  provider: WebSocketProvider,
  txHash: string,
  receipt: TransactionReceipt | null,
): Promise<string> {
  // 80 credits
  const transaction = await getTransactionWithRaw(provider, txHash);

  if (receipt === null) {
    // 80 credits
    receipt = await provider.getTransactionReceipt(txHash);
  }
  const encodedData = abiEncode({ kind: 'ethereum', tx: transaction!, rx: receipt! });
  return encodedData.abi;
}

async function encodeAndWriteToDisk(
  pathToStoreJson: string,
  provider: WebSocketProvider,
  blockNumber: number,
  txHash: string,
  receipt: TransactionReceipt | null,
) {
  const encodedData = await encodeTransaction(provider, txHash, receipt);

  const encodedSize = bytesInHexString(encodedData);
  if (encodedSize > MAX_ENCODED_SIZE) {
    // Do NOT abort: we still want to encode and persist oversized blocks so the
    // run continues. Log in the exact `encoded data exceeds MAX_ENCODED_SIZE`
    // format so a downstream CI step can grep for it and fail the pipeline.
    console.error(
      `encoded data exceeds MAX_ENCODED_SIZE: blockNumber=${blockNumber} txHash=${txHash} encodedSize=${encodedSize} bytes (max=${MAX_ENCODED_SIZE})`,
    );
  }

  writeFileSync(`${pathToStoreJson}/${blockNumber}/${txHash}.txt`, encodedData + '\n', {
    flag: 'w',
  });
}

// https://docs.metamask.io/services/get-started/pricing/credit-cost#standard-ethereum-compliant-methods
// cost: (80 + 160 * <txns in block>)
async function blockHandler(
  prefix: string,
  provider: WebSocketProvider,
  blockNumber: number,
  pathToStoreJson: string,
): Promise<void> {
  console.log(`new ${prefix} --- ${blockNumber}`);

  mkdirSync(`${pathToStoreJson}/${blockNumber}`, { recursive: true });

  // cost: 80 credits
  const block = await provider.getBlock(blockNumber);
  const txHashes = block?.transactions || [];

  if (txHashes?.length >= 13) {
    // optimize RPC cost by fetching all receipts at once
    const receipts = await getBlockReceipts(provider, block!);

    await Promise.all(
      receipts.map(async (receipt) => {
        await encodeAndWriteToDisk(pathToStoreJson, provider, blockNumber, receipt.hash, receipt);
      }),
    );
  } else {
    // loop over each transaction and fetch its receipt via explicit RPC call
    await Promise.all(
      txHashes.map(async (txHash) => {
        await encodeAndWriteToDisk(pathToStoreJson, provider, blockNumber, txHash, null);
      }),
    );
  }

  console.log(`<<< done encoding ${txHashes?.length} transactions in block ${blockNumber}`);
}

async function encodeBlocks(rpcUrl: string, pathToStoreJson: string): Promise<void> {
  const start = Date.now();
  const timeoutMinutes = parseInt(process.env.TIMEOUT_MINUTES || '2');
  console.log(`=== starting with timeout ${timeoutMinutes} mins ...`);

  mkdirSync(pathToStoreJson, { recursive: true });

  const provider = new WebSocketProvider(rpcUrl);

  // Fire the event whenever the block changes.
  // We can also fire on 'safe' or 'finalized' blocks
  provider.on('block', async (blockNumber) => {
    try {
      // cost: (80 + 160 * <txns in block>)
      await blockHandler('block', provider, blockNumber, pathToStoreJson);
    } catch (err) {
      // A transient RPC error (e.g. `-32000 internal error` from the upstream
      // provider) should not kill the whole run. Log it and move on to the
      // next block — we'd rather skip one block than abort 60 minutes of work.
      console.error(`!!! skipping block ${blockNumber} due to error:`, err);
    }

    if (Math.floor((Date.now() - start) / 60000) >= timeoutMinutes) {
      console.log(`=== ${timeoutMinutes} mins timeout reached. exiting ...`);
      process.exit(0);
    }
  });
}

if (process.argv.length < 4) {
  console.error('node dist/bin/encode-blocks.js <ws://ethRpcUrl> <pathToStoreJson>');
  process.exit(1);
}

const rpcUrl = process.argv[2] || 'ws://127.0.0.1:8545';
const pathToStoreJson = process.argv[3];

encodeBlocks(rpcUrl, pathToStoreJson).catch((reason) => {
  console.error(reason);
  process.exit(1);
});
