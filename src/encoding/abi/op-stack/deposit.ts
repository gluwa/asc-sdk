/** The OP-Stack `0x7e` deposit transaction: types, nonce canonicalization and EIP-2718 encoding. */
import { encodeRlp, keccak256, toBeHex } from 'ethers';
import type { TransactionReceipt } from 'ethers';

/** EIP-2718 type byte of an OP-Stack deposit transaction. */
export const DEPOSIT_TX_TYPE = 0x7e;

/**
 * Raised when a deposit receipt reports a `depositReceiptVersion` but no `depositNonce`;
 * op-geth never produces this shape.
 */
export class MissingDepositNonceError extends Error {
  constructor() {
    super('deposit receipt has depositReceiptVersion but no depositNonce');
    this.name = 'MissingDepositNonceError';
  }
}

/** Deposit-specific receipt fields (`depositNonce` / `depositReceiptVersion`). */
export interface DepositReceiptFields {
  /** Sequencer-assigned deposit nonce (Regolith and later). */
  depositNonce?: bigint | number | null;
  /** Receipt encoding version (Canyon and later, currently always `1`). */
  depositReceiptVersion?: bigint | number | null;
}

/**
 * The nonce that goes into the leaf.
 *
 * Only Canyon and later receipt roots commit to the nonce. Earlier metadata must not
 * influence an attestation leaf, even when a provider happens to include it, so those
 * receipts canonicalize to zero.
 *
 * @throws {MissingDepositNonceError} if the receipt is versioned but carries no nonce
 */
export function canonicalNonce(fields: DepositReceiptFields): bigint {
  if (fields.depositReceiptVersion == null) {
    return 0n;
  }
  if (fields.depositNonce == null) {
    throw new MissingDepositNonceError();
  }
  return BigInt(fields.depositNonce);
}

/**
 * An OP-Stack deposit transaction as it appears in an L2 block.
 *
 * Field names follow the OP-Stack spec. `nonce` is not part of the transaction's consensus
 * encoding; set it from {@link canonicalNonce}.
 */
export interface DepositTransaction {
  /** Transaction hash. */
  hash: string;
  /**
   * Uniquely identifies the L1 origin of this deposit (user-deposited and L1-info deposits
   * derive it differently).
   */
  sourceHash: string;
  /** L2 sender. For the L1-attributes deposit this is the fixed depositor address. */
  from: string;
  /** Call target, or `null` for contract creation. */
  to: string | null;
  /** ETH minted on L2 as part of this deposit. */
  mint: bigint;
  /** ETH value transferred from `from` to `to`. */
  value: bigint;
  /** Gas limit. */
  gasLimit: bigint;
  /**
   * Whether the deposit is exempt from L2 gas accounting (always `false` since Regolith, but
   * still part of the encoding).
   */
  isSystemTx: boolean;
  /** Calldata. */
  input: string;
  /** Receipt-backed nonce since Canyon; zero (unavailable) before Canyon. */
  nonce: bigint;
}

/**
 * A deposit receipt. Only the fields that go into the leaf are required, so an ethers
 * `TransactionReceipt` satisfies it.
 */
export type DepositReceipt = Pick<TransactionReceipt, 'status' | 'gasUsed' | 'logsBloom'> & {
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>;
};

/** RLP integers are big-endian without leading zeros; zero is the empty string. */
function rlpUint(value: bigint): string {
  return value === 0n ? '0x' : toBeHex(value);
}

/** EIP-2718 encoding: `0x7e || rlp([sourceHash, from, to, mint, value, gas, isSystemTx, data])`. */
export function encode2718(tx: DepositTransaction): string {
  const payload = encodeRlp([
    tx.sourceHash,
    tx.from,
    tx.to ?? '0x',
    rlpUint(tx.mint),
    rlpUint(tx.value),
    rlpUint(tx.gasLimit),
    tx.isSystemTx ? '0x01' : '0x',
    tx.input,
  ]);
  return `0x${DEPOSIT_TX_TYPE.toString(16)}${payload.slice(2)}`;
}

/**
 * Hash of the EIP-2718 encoding. Equals `tx.hash` for a well-formed deposit, which lets
 * callers verify an RPC-reported hash against the fields they parsed.
 */
export function computedHash(tx: DepositTransaction): string {
  return keccak256(encode2718(tx));
}
