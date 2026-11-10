import { AbiCoder, getAddress, ZeroAddress } from 'ethers';
import { EncodingResult } from '../common';
import { DEPOSIT_TX_TYPE, DepositReceipt, DepositTransaction } from './deposit';

/** Flat ABI types of the V1 deposit leaf, in field order across the three chunks. */
const DEPOSIT_TYPES_V1 = [
  // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
  'uint64',
  'uint64',
  'address',
  'bool',
  'address',
  'uint256',
  'bytes',
  // Chunk 2: Deposit fields (sourceHash, mint, isSystemTx)
  'bytes32',
  'uint256',
  'bool',
  // Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
  'uint8',
  'uint64',
  'tuple(address, bytes32[], bytes)[]',
  'bytes',
];

/**
 * ABI-encodes the V1 Merkle leaf for a (deposit tx, receipt) pair. See the
 * [module docs](./index.ts) for the layout.
 */
export function abiEncode(tx: DepositTransaction, rx: DepositReceipt): EncodingResult {
  const coder = AbiCoder.defaultAbiCoder();

  const common = coder.encode(
    ['uint64', 'uint64', 'address', 'bool', 'address', 'uint256', 'bytes'],
    [tx.nonce, tx.gasLimit, tx.from, tx.to == null, tx.to ? getAddress(tx.to) : ZeroAddress, tx.value, tx.input],
  );

  const deposit = coder.encode(['bytes32', 'uint256', 'bool'], [tx.sourceHash, tx.mint, tx.isSystemTx]);

  // For status field, default to 1 (success) if undefined (pre-EIP-658 receipts), as for
  // the Ethereum encoder. A post-state receipt cannot occur on an OP-Stack chain.
  const receipt = coder.encode(
    ['uint8', 'uint64', 'tuple(address, bytes32[], bytes)[]', 'bytes'],
    [rx.status ?? 1, rx.gasUsed, rx.logs.map((log) => [log.address, log.topics, log.data]), rx.logsBloom],
  );

  const abi = coder.encode(['uint8', 'bytes[]'], [DEPOSIT_TX_TYPE, [common, deposit, receipt]]);

  return { types: DEPOSIT_TYPES_V1, abi };
}
