import { TransactionReceipt, keccak256, solidityPacked } from 'ethers';

import { abiEncode, EncodingVersion, TransactionWithRaw } from '../encoding';

export class TransactionMerkleProof {
  public root: string;
  public siblings: MerkleProofEntry[];

  constructor(root: string, siblings: MerkleProofEntry[]) {
    this.root = root;
    this.siblings = siblings;
  }
}

export class MerkleProofEntry {
  public hash: string;
  public isLeft: boolean;

  constructor(hash: string, isLeft: boolean) {
    this.hash = hash;
    this.isLeft = isLeft;
  }
}

/**
 * Hashes two child nodes to produce their parent node in the Merkle tree.
 *
 * @param left A 32-byte hex string representing the left child hash
 * @param right A 32-byte hex string representing the right child hash
 * @returns A 32-byte hex string representing the parent node hash
 */
export function hashInner(left: string, right: string): string {
  // Use solidityPacked to exactly match Solidity's abi.encodePacked(uint8(0x01), bytes32, bytes32)
  return keccak256(solidityPacked(['uint8', 'bytes32', 'bytes32'], [0x01, left, right]));
}

/**
 * Hashes a leaf node to produce its hash in the Merkle tree.
 *
 * @param leaf A 32-byte hex string representing the data to be hashed as a leaf
 * @returns A 32-byte hex string representing the leaf node hash
 */
export function hashLeaf(leaf: string): string {
  // Use solidityPacked to exactly match Solidity's abi.encodePacked(uint8(0x00), bytes)
  return keccak256(solidityPacked(['uint8', 'bytes'], [0x00, leaf]));
}

/**
 * Constant zero hash (32 bytes of zero) used in Merkle tree calculations
 */
export const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Computes the Merkle root of a block's transactions using Keccak-256 hashing.
 *
 * The receipts **must correspond to the transactions and be ordered by transaction index**.
 * Otherwise, the result will be **incorrect**.
 *
 * @param transactions Array of transactions with raw data
 * @param receipts Transaction receipts corresponding to the block's transactions
 * @param encoding Encoding version to use for ABI encoding of transactions and receipts
 * @returns Merkle root of the block's transactions as a hex string of 32 bytes (H256 hash)
 */
export function computeMerkleRootOfBlock(
  transactions: TransactionWithRaw[],
  receipts: TransactionReceipt[],
  encoding: EncodingVersion,
): string {
  // Encode all transactions in the block
  const leaves = transactions.map((tx, index) => {
    const receipt = receipts[index];
    const result = abiEncode({ kind: 'ethereum', tx, rx: receipt }, encoding);

    return result.abi;
  });

  // If the block has no transactions, return the default hash
  if (leaves.length === 0) {
    return ZERO_HASH;
  }

  if (leaves.length === 1) {
    // Single leaf: hash it with leaf prefix to get the root
    return hashLeaf(leaves[0]);
  }

  // Multiple leaves: build the Merkle tree
  const tree = new KeccakMerkleTree(leaves);
  return tree.getRoot();
}

/**
 * Computes the digest of a block given its number, Merkle root, and previous digest.
 *
 * This function uses Keccak-256 hashing on the packed encoding of the block number,
 * Merkle root, and previous digest to produce a unique digest for the block.
 *
 * The merkle root has to be a **hex string of 32 bytes (H256)**, and the previous digest has to be a **hex string of 32 bytes (H256)** as well.
 * Otherwise, the method will error out.
 *
 *
 * @param blockNumber The block number
 * @param merkleRoot The Merkle root of the block
 * @param prevDigest The digest of the previous block
 * @returns The computed digest as a hex string
 */
export function computeDigestOf(blockNumber: number, merkleRoot: string, prevDigest: string | null): string {
  // If prevDigest is provided, include it in the packed encoding
  if (prevDigest) {
    return keccak256(solidityPacked(['uint64', 'bytes32', 'bytes32'], [blockNumber, merkleRoot, prevDigest]));
  }

  // Otherwise, only use blockNumber and merkleRoot
  return keccak256(solidityPacked(['uint64', 'bytes32'], [blockNumber, merkleRoot]));
}

export class KeccakMerkleTree {
  /// All levels of the tree, from leaves to root
  private levels: string[][];

  /// Create a new Merkle tree from raw data items
  constructor(items: string[]) {
    const levels: string[][] = [];
    let currentLevel = items.map((item) => hashLeaf(item));
    let currentLen = currentLevel.length;

    while (currentLen > 0) {
      const nextLevel =
        currentLen > 1
          ? Array.from({ length: Math.ceil(currentLen / 2) }, (_, i) => {
              const leftIndex = i * 2;
              const left = currentLevel[leftIndex];
              const right = currentLevel[leftIndex + 1] || ZERO_HASH;
              return hashInner(left, right);
            })
          : [];

      levels.push(currentLevel);
      currentLevel = nextLevel;
      currentLen = currentLevel.length;
    }

    this.levels = levels;
  }

  public getLevels(): string[][] {
    return this.levels;
  }

  public getRoot(): string {
    return this.levels.length > 0 ? this.levels[this.levels.length - 1][0] : ZERO_HASH;
  }

  public getProof(leafIndex: number): TransactionMerkleProof {
    // Check if tree is empty
    if (this.levels.length === 0) {
      throw new Error('Cannot generate proof from empty tree');
    }

    // Check if index is out of range
    const leafCount = this.levels[0]?.length || 0;
    if (leafIndex >= leafCount) {
      throw new Error(`Index ${leafIndex} out of range. Max index: ${leafCount - 1}`);
    }

    let currentIndex = leafIndex;

    // Traverse from leaf to root (excluding the root level)
    const path = this.levels
      .slice()
      .reverse()
      .slice(1)
      .reverse()
      .map((level) => {
        // sibling_offset is opposite to the item's offset which is (current_index % 2):
        // 0 -> 1
        // 1 -> 0
        const siblingOffset = 1 - (currentIndex % 2);
        // transform sibling offset to sibling index in the current level:
        // 0 -> current_index - 1
        // 1 -> current_index + 1
        const siblingIndex = currentIndex + 2 * siblingOffset - 1;

        // Move to parent index
        currentIndex = Math.floor(currentIndex / 2);

        return new MerkleProofEntry(level[siblingIndex] || ZERO_HASH, siblingOffset === 0);
      });

    return new TransactionMerkleProof(this.getRoot(), path);
  }
}
