/**
 * OP-Stack specifics: the `0x7e` **deposit transaction** and its Merkle leaf.
 *
 * OP-Stack rollups (Base, OP Mainnet, ...) are Ethereum-equivalent except for one extra
 * transaction type. Every L2 block opens with a deposit transaction that writes the L1 block
 * attributes into the `L1Block` predeploy, and user deposits through the `OptimismPortal` are
 * delivered the same way. Deposit transactions are *unsigned* (they are derived from L1) and
 * carry three fields no L1 type has: `sourceHash`, `mint` and `isSystemTx`.
 *
 * ethers cannot represent the `0x7e` type as a `TransactionResponse`, so this module has its own
 * {@link DepositTransaction} type. Parsing it out of an RPC response is the caller's job.
 *
 * ## Specification references
 *
 * - Deposit transaction type and RLP layout: OP-Stack specs, `deposits.md`
 *   (`0x7E || rlp([sourceHash, from, to, mint, value, gas, isSystemTx, data])`).
 * - Receipt encoding: `op-geth` `core/types/receipt.go`, `Receipts.EncodeIndex`.
 *
 * ## Leaf layout (`txType = 126`)
 *
 * Three chunks, mirroring the V1 layout for types `0x0`-`0x2` so a decoder that already
 * understands the common and receipt chunks needs only the middle one:
 *
 * | chunk         | fields                                                                                  |
 * | ------------- | --------------------------------------------------------------------------------------- |
 * | `chunks[0]` common  | `(uint64 nonce, uint64 gasLimit, address from, bool toIsNull, address to, uint256 value, bytes data)` |
 * | `chunks[1]` deposit | `(bytes32 sourceHash, uint256 mint, bool isSystemTx)`                             |
 * | `chunks[2]` receipt | `(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)` |
 *
 * `nonce` is the receipt's `depositNonce` when `depositReceiptVersion` is present (Canyon
 * and later), so it is authenticated by the header's `receiptsRoot`. Before Canyon neither the
 * transaction root nor the receipt root commits to a nonce: the leaf uses **zero**, meaning
 * unavailable, even if RPC metadata reports a nonzero execution nonce. Do not use that
 * historical zero to derive a contract-creation address. There are no signature fields:
 * deposits are unsigned.
 */

import { EncodingVersion, EncodingResult } from '../common';
import { abiEncode as abiEncodeV1 } from './v1';
import type { DepositReceipt, DepositTransaction } from './deposit';

export * from './deposit';

/**
 * ABI-encodes the Merkle leaf for a (deposit tx, receipt) pair according to the specified
 * encoding version. See the [module docs](./index.ts) for the layout.
 */
export function abiEncode(
  tx: DepositTransaction,
  rx: DepositReceipt,
  encoding: EncodingVersion = EncodingVersion.V1,
): EncodingResult {
  switch (encoding) {
    case EncodingVersion.V1:
      return abiEncodeV1(tx, rx);
    default:
      return abiEncodeV1(tx, rx);
  }
}
