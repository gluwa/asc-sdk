/**
 * ABI encoding of transactions and their receipts into Merkle leaves.
 *
 * The encodings are grouped in one submodule per transaction **family**, because each family
 * has its own leaf layouts. Inside a family, one file per **encoding version** (`v1.ts`, ...)
 * holds that version's layout, and the family's `index.ts` documents the layout and picks the
 * file for a given {@link EncodingVersion}:
 *
 * - [`ethereum/`](./ethereum/index.ts): types `0x0`-`0x4`.
 * - [`op-stack/`](./op-stack/index.ts): the OP-Stack `0x7e` deposit.
 *
 * This file only dispatches on the family (see {@link TxRxInput}). To support a new family, add
 * a submodule following the same shape and a variant to {@link TxRxInput}; to add an encoding
 * version, add a variant to {@link EncodingVersion} (in `common.ts`) and a file to every family.
 */
import { abiEncode as abiEncodeEthereum } from './ethereum';
import { abiEncode as abiEncodeOpStack, DepositReceipt, DepositTransaction } from './op-stack';
import { TransactionReceipt } from 'ethers';
import { EncodingResult, EncodingVersion } from './common';
import { TransactionWithRaw } from '../common';

export * from './common';
export * as opStack from './op-stack';
export type { DepositReceipt, DepositTransaction } from './op-stack';

/**
 * A transaction and its receipt, ready to be encoded into a Merkle leaf.
 *
 * The `kind` selects the leaf layout, i.e. which "family" submodule encodes it.
 */
export type TxRxInput =
  /**
   * A standard Ethereum transaction (types `0x0`-`0x4`) and its receipt. Also the right
   * variant for the non-deposit transactions of an OP-Stack block.
   */
  | { kind: 'ethereum'; tx: TransactionWithRaw; rx: TransactionReceipt }
  /** An OP-Stack deposit transaction (type `0x7e`) and its receipt. */
  | { kind: 'opDeposit'; tx: DepositTransaction; rx: DepositReceipt };

/**
 * Encodes a given transaction and its receipt into ABI format according to the specified
 * encoding version.
 *
 * The encodings are grouped in one submodule per transaction family, each with one file per
 * encoding version:
 * - `ethereum/`: for `kind: 'ethereum'`, the transaction and receipt are expected to comply with
 *   the ethereum specifications as modelled by `ethers`.
 * - `op-stack/`: for `kind: 'opDeposit'`, with the OP-Stack specification (see {@link opStack}).
 */
export function abiEncode(input: TxRxInput, encoding: EncodingVersion = EncodingVersion.V1): EncodingResult {
  switch (input.kind) {
    case 'ethereum':
      return abiEncodeEthereum(input.tx, input.rx, encoding);
    case 'opDeposit':
      return abiEncodeOpStack(input.tx, input.rx, encoding);
  }
}
