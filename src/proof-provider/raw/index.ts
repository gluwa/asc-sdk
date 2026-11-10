import { BatchMerkleProofEntry, BatchProofResult, ProofResult, ProofProvider } from '..';
import { ChainInfoProvider } from '../../chain-info';

import { abiEncode, EncodingVersion } from '../../encoding';

import { ContinuityProofBuilder } from './continuity-proof';
import { KeccakMerkleTree, TransactionMerkleProof } from '../merkle';
import { BlockProvider } from './block-provider';

// Re-export for easier access
export * as blockProvider from './block-provider';
export { EncodingVersion } from '../../encoding';

interface MerkleProofResult {
  success: boolean;
  txIndex?: number;
  txBytes?: string;
  blockNumber?: number;
  merkleProof?: TransactionMerkleProof;
  error?: string;
}

/**
 * RawProofBuilder generates raw proofs for a given transaction.
 *
 * It uses a BlockProvider to fetch block and transaction data from the source chain. And a ChainInfoProvider
 * to get chain-specific information needed for proof generation from the attestation chain.
 *
 * The builder constructs Merkle proofs for transactions and continuity proofs for blocks.
 */
export class RawProofBuilder implements ProofProvider {
  private blockProvider: BlockProvider;
  private chainInfoProvider: ChainInfoProvider;

  private chainKey: number;
  private builder: ContinuityProofBuilder;

  constructor(
    chainKey: number,
    blockProvider: BlockProvider,
    chainInfoProvider: ChainInfoProvider,
    encoding: EncodingVersion,
  ) {
    this.blockProvider = blockProvider;
    this.chainInfoProvider = chainInfoProvider;
    this.chainKey = chainKey;
    this.builder = new ContinuityProofBuilder(this.blockProvider, this.chainInfoProvider, chainKey, encoding);
  }

  private async generateMerkleProofFor(transactionHash: string): Promise<MerkleProofResult> {
    // First we need to create merkle proof for the transaction block
    const tx = await this.blockProvider.getTransaction(transactionHash);
    if (!tx) {
      return { success: false, error: `Transaction ${transactionHash} not found` };
    }

    const txIndex = tx.formatted.index;
    const blockNumber = tx.formatted.blockNumber;
    const blockHash = tx.formatted.blockHash;

    // If transaction is pending, we cannot generate a proof since it's not in a block yet which could be attested
    if (!blockNumber || !blockHash) {
      return { success: false, error: `Transaction ${transactionHash} is pending and not yet included in a block` };
    }

    console.log(`Transaction found in block ${blockNumber}: ${blockHash} at index ${txIndex}`);

    const blockWithReceipts = await this.blockProvider.getBlockWithReceipts(blockNumber);
    if (!blockWithReceipts) {
      return { success: false, error: `Block ${blockNumber} not found for transaction ${transactionHash}` };
    }
    const orderedReceipts = blockWithReceipts.receipts.sort((a, b) => a.index - b.index);

    // We need the data of all transactions in the block
    // to build the merkle proof of the block
    const transactions = [];
    for (const txHash of blockWithReceipts.block.transactions) {
      const txData = await this.blockProvider.getTransaction(txHash);
      if (txData) {
        transactions.push(txData);
      } else {
        return { success: false, error: `Transaction ${txHash} not found in block ${blockNumber}` };
      }

      // Small delay to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // If for some reason the counts don't match, error out
    if (transactions.length !== orderedReceipts.length) {
      return {
        success: false,
        error: `Mismatch between transactions and receipts count in block ${blockNumber}`,
      };
    }

    // We can now ABI encode all transactions in the block
    // which will be the leaves of the merkle tree
    const encodedTx = transactions.map((txData, idx) => {
      // ABI encoded transaction + receipt
      const encoded = abiEncode({ kind: 'ethereum', tx: txData!, rx: orderedReceipts[idx] }, EncodingVersion.V1);

      return encoded.abi;
    });

    // We can now build the merkle tree and proof
    // for the transaction at txIndex
    const tree = new KeccakMerkleTree(encodedTx);
    const merkleProof = tree.getProof(txIndex);

    return {
      success: true,
      txIndex,
      txBytes: encodedTx[txIndex],
      blockNumber,
      merkleProof,
    };
  }

  public async getProof(transactionHash: string): Promise<ProofResult> {
    const merkleProofResult = await this.generateMerkleProofFor(transactionHash);

    if (!merkleProofResult.success) {
      return { success: false, error: `Failed to generate merkle proof: ${merkleProofResult.error}` };
    }

    try {
      const continuityProof = await this.builder.createForHeights(merkleProofResult.blockNumber!);

      return {
        success: true,
        data: {
          chainKey: this.chainKey,
          headerNumber: merkleProofResult.blockNumber!,
          txIndex: merkleProofResult.txIndex!,
          txHash: transactionHash,
          txBytes: merkleProofResult.txBytes!,
          continuityProof: continuityProof,
          merkleProof: merkleProofResult.merkleProof!,
          cached: false,
          generatedAt: new Date(),
        },
      };
    } catch (e) {
      return { success: false, error: `Failed to build continuity proof: ${(e as Error).message}` };
    }
  }

  public async getBatchProof(transactionHashes: string[]): Promise<BatchProofResult> {
    if (transactionHashes.length === 0) {
      return { success: false, error: 'No transaction hashes provided for batch proof generation' };
    }

    // Remove duplicated items from transactionHashes
    const uniqueTransactionHashes = Array.from(new Set(transactionHashes));

    const merkleProofResults = await Promise.all(
      uniqueTransactionHashes.map(async (hash) => await this.generateMerkleProofFor(hash)),
    );

    const successfulResults = merkleProofResults.filter((result) => result.success);

    console.log(`Generated merkle proofs for ${successfulResults} transactions in batch request`);

    const fromHeader = Math.min(...successfulResults.map((result) => result.blockNumber!));
    const toHeader = Math.max(...successfulResults.map((result) => result.blockNumber!));

    const merkleProofsMap: Map<number, Map<number, BatchMerkleProofEntry>> = new Map();

    for (const result of successfulResults) {
      if (!merkleProofsMap.has(result.blockNumber!)) {
        merkleProofsMap.set(result.blockNumber!, new Map());
      }

      merkleProofsMap.get(result.blockNumber!)!.set(result.txIndex!, {
        txHash: transactionHashes[merkleProofResults.indexOf(result)],
        txBytes: result.txBytes!,
        merkleProof: result.merkleProof!,
      });
    }

    try {
      const continuityProof = await this.builder.createForHeights(fromHeader, toHeader);

      return {
        success: true,
        data: {
          chainKey: this.chainKey,
          fromHeader,
          toHeader,
          continuityProof: continuityProof,
          merkleProofs: merkleProofsMap,
          cached: false,
          generatedAt: new Date(),
        },
      };
    } catch (e) {
      return { success: false, error: `Failed to build continuity proof: ${(e as Error).message}` };
    }
  }
}
