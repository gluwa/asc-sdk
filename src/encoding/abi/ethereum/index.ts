/**
 * Standard Ethereum transactions (types `0x0`-`0x4`) and their Merkle leaves, one file per
 * encoding version. This is also the encoding of the non-deposit transactions of an OP-Stack
 * block; only the `0x7e` deposit needs the [`op-stack`](../op-stack/index.ts) module.
 *
 * # Specification references
 *
 * - Typed transaction envelope: EIP-2718. Types: legacy (`0x0`), EIP-2930 (`0x1`), EIP-1559
 *   (`0x2`), EIP-4844 (`0x3`) and EIP-7702 (`0x4`).
 * - Receipt status: EIP-658.
 *
 * # Leaf layout (`txType = 0..=4`)
 *
 * The leaf is `(uint8 txType, bytes[] chunks)`, so the type can be read without decoding the
 * chunks. Each chunk is itself an ABI-encoded tuple. The first chunk (common) and the last chunk
 * (receipt) are identical for every type:
 *
 * | chunk        | fields                                                                                                  |
 * | ------------ | ------------------------------------------------------------------------------------------------------- |
 * | common       | `(uint64 nonce, uint64 gasLimit, address from, bool toIsNull, address to, uint256 value, bytes data)`   |
 * | receipt      | `(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)`                     |
 *
 * Type-specific chunks, between the common and the receipt chunk:
 * - `0` (legacy), one chunk: `(uint128 gasPrice, uint256 v, bytes32 r, bytes32 s)`
 * - `1` (access list), one chunk: `(uint64 chainId, uint128 gasPrice, accessList, uint8 yParity, bytes32 r, bytes32 s)`
 * - `2` (dynamic fee), one chunk:
 *   `(uint64 chainId, uint128 maxPriorityFeePerGas, uint128 maxFeePerGas, accessList, uint8 yParity, bytes32 r, bytes32 s)`
 * - `3` (blob), two chunks: `(uint64 chainId, uint128 maxPriorityFeePerGas, uint128 maxFeePerGas, accessList)`, then
 *   `(uint256 maxFeePerBlobGas, bytes32[] blobVersionedHashes, uint8 yParity, bytes32 r, bytes32 s)`
 * - `4` (set code), two chunks: `(uint64 chainId, uint128 maxPriorityFeePerGas, uint128 maxFeePerGas, accessList)`,
 *   then `(authorizationList, uint8 yParity, bytes32 r, bytes32 s)`
 *
 * where `accessList` is `(address,bytes32[])[]` and `authorizationList` is
 * `(uint256 chainId, address address, uint64 nonce, uint8 yParity, uint256 r, uint256 s)[]`.
 *
 * Notes on individual fields:
 * - `v` of a legacy transaction is the EIP-155 `v` (`signature.networkV`) when present.
 * - ethers does not expose the raw `yParity` of authorization list entries, so type `0x4` reads
 *   it from the raw JSON-RPC response; see `TransactionWithRaw`.
 * - `status` defaults to `1` for pre-EIP-658 receipts, which carry no status.
 */
import { TransactionReceipt } from 'ethers';
import { EncodingResult, EncodingVersion } from '../common';
import { TransactionWithRaw } from '../../common';
import { abiEncode as abiEncodeV1 } from './v1';

/**
 * ABI-encodes the Merkle leaf for an Ethereum transaction and its receipt according to the
 * specified encoding version.
 */
export function abiEncode(
  tx: TransactionWithRaw,
  rx: TransactionReceipt,
  encoding: EncodingVersion = EncodingVersion.V1,
): EncodingResult {
  switch (encoding) {
    case EncodingVersion.V1:
      return abiEncodeV1(tx, rx);
    default:
      return abiEncodeV1(tx, rx);
  }
}
