import { TransactionResponse, TransactionReceipt, AccessList, AbiCoder, Authorization } from 'ethers';
import { addressOrZero } from '../../utils';
import { RawAuthorization, RawTransactionResponse, TransactionWithRaw } from '../../common';
import { EncodingResult } from '../common';

/**
 * Encodes common transaction fields that are shared across all transaction types
 * Fields: nonce, gasLimit, from, toIsNull, to, value, data (7 fields)
 */
function encodeCommonFields(tx: TransactionResponse): string {
  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ['uint64', 'uint64', 'address', 'bool', 'address', 'uint256', 'bytes'],
    [tx.nonce, tx.gasLimit, tx.from, tx.to == null, addressOrZero(tx.to), tx.value, tx.data],
  );
}

/**
 * Encodes receipt fields that are identical across all transaction types
 * Fields: receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom (4 fields)
 */
function encodeReceiptFields(rx: TransactionReceipt): string {
  const coder = AbiCoder.defaultAbiCoder();

  // For status field, default to 1 (success) if undefined (pre-EIP-658 receipts)
  // See: https://eips.ethereum.org/EIPS/eip-658
  return coder.encode(
    ['uint8', 'uint64', 'tuple(address, bytes32[], bytes)[]', 'bytes'],
    [rx.status ?? 1, rx.gasUsed, rx.logs.map((log) => [log.address, log.topics, log.data]), rx.logsBloom],
  );
}

/**
 * Explicit chunk creation for Type 0 transaction (Legacy)
 * Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
 * Chunk 2: Type-specific fields (gasPrice, v, r, s)
 * Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
 */
function getChunksForType0(tx: TransactionResponse, rx: TransactionReceipt): string[] {
  const coder = AbiCoder.defaultAbiCoder();

  // Chunk 1: Common fields
  const chunk1 = encodeCommonFields(tx);

  // Chunk 2: Type-specific fields (gasPrice, v, r, s)
  const chunk2 = coder.encode(
    ['uint128', 'uint256', 'bytes32', 'bytes32'],
    [tx.gasPrice, tx.signature.networkV ?? tx.signature.v, tx.signature.r, tx.signature.s],
  );

  // Chunk 3: Receipt fields
  const chunk3 = encodeReceiptFields(rx);

  return [chunk1, chunk2, chunk3];
}

/**
 * Explicit chunk creation for Type 1 transaction (Access List)
 * Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
 * Chunk 2: Type-specific fields (chainId, gasPrice, accessList, yParity, r, s)
 * Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
 */
function getChunksForType1(tx: TransactionResponse, rx: TransactionReceipt): string[] {
  const coder = AbiCoder.defaultAbiCoder();

  // Chunk 1: Common fields
  const chunk1 = encodeCommonFields(tx);

  // Chunk 2: Type-specific fields (chainId, gasPrice, accessList, yParity, r, s)
  const chunk2 = coder.encode(
    ['uint64', 'uint128', 'tuple(address,bytes32[])[]', 'uint8', 'bytes32', 'bytes32'],
    [tx.chainId, tx.gasPrice, encodeAccessList(tx.accessList), tx.signature.yParity, tx.signature.r, tx.signature.s],
  );

  // Chunk 3: Receipt fields
  const chunk3 = encodeReceiptFields(rx);

  return [chunk1, chunk2, chunk3];
}

/**
 * Explicit chunk creation for Type 2 transaction (EIP-1559)
 * Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
 * Chunk 2: Type-specific fields (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList, yParity, r, s)
 * Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
 */
function getChunksForType2(tx: TransactionResponse, rx: TransactionReceipt): string[] {
  const coder = AbiCoder.defaultAbiCoder();

  // Chunk 1: Common fields
  const chunk1 = encodeCommonFields(tx);

  // Chunk 2: Type-specific fields (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList, yParity, r, s)
  const chunk2 = coder.encode(
    ['uint64', 'uint128', 'uint128', 'tuple(address,bytes32[])[]', 'uint8', 'bytes32', 'bytes32'],
    [
      tx.chainId,
      tx.maxPriorityFeePerGas,
      tx.maxFeePerGas,
      encodeAccessList(tx.accessList),
      tx.signature.yParity,
      tx.signature.r,
      tx.signature.s,
    ],
  );

  // Chunk 3: Receipt fields
  const chunk3 = encodeReceiptFields(rx);

  return [chunk1, chunk2, chunk3];
}

function encodeAccessList(accessList: AccessList | null) {
  if (accessList == null) return [];

  return accessList.map((entry) => [entry.address, entry.storageKeys]);
}

/**
 * Explicit chunk creation for Type 3 transaction (Chunk)
 * Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
 * Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
 * Chunk 3: Type-specific fields part 2 (maxFeePerChunkGas, blobVersionedHashes, yParity, r, s)
 * Chunk 4: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
 */
function getChunksForType3(tx: TransactionResponse, rx: TransactionReceipt): string[] {
  const coder = AbiCoder.defaultAbiCoder();

  // Chunk 1: Common fields
  const chunk1 = encodeCommonFields(tx);

  // Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
  const chunk2 = coder.encode(
    ['uint64', 'uint128', 'uint128', 'tuple(address,bytes32[])[]'],
    [tx.chainId, tx.maxPriorityFeePerGas, tx.maxFeePerGas, encodeAccessList(tx.accessList)],
  );

  // Chunk 3: Type-specific fields part 2 (maxFeePerChunkGas, blobVersionedHashes, yParity, r, s)
  const chunk3 = coder.encode(
    ['uint256', 'bytes32[]', 'uint8', 'bytes32', 'bytes32'],
    [tx.maxFeePerBlobGas, tx.blobVersionedHashes, tx.signature.yParity, tx.signature.r, tx.signature.s],
  );

  // Chunk 4: Receipt fields
  const chunk4 = encodeReceiptFields(rx);

  return [chunk1, chunk2, chunk3, chunk4];
}

function encodeAuthorizationList(
  authorizationList: Array<Authorization> | null,
  rawAuthorizationList: Array<RawAuthorization> | null,
) {
  if (authorizationList == null) return [];

  return authorizationList.map((entry, i) => [
    entry.chainId,
    entry.address,
    entry.nonce,
    rawAuthorizationList![i].yParity,
    entry.signature.r,
    entry.signature._s,
  ]);
}

/**
 * Explicit chunk creation for Type 4 transaction (Authorization)
 * Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
 * Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
 * Chunk 3: Type-specific fields part 2 (authorizationList, yParity, r, s)
 * Chunk 4: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
 */
function getChunksForType4(tx: TransactionResponse, raw: RawTransactionResponse, rx: TransactionReceipt): string[] {
  const coder = AbiCoder.defaultAbiCoder();

  // Chunk 1: Common fields
  const chunk1 = encodeCommonFields(tx);

  // Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
  const chunk2 = coder.encode(
    ['uint64', 'uint128', 'uint128', 'tuple(address,bytes32[])[]'],
    [tx.chainId, tx.maxPriorityFeePerGas, tx.maxFeePerGas, encodeAccessList(tx.accessList)],
  );

  // Chunk 3: Type-specific fields part 2 (authorizationList, yParity, r, s)
  const chunk3 = coder.encode(
    ['tuple(uint256,address,uint64,uint8,uint256,uint256)[]', 'uint8', 'bytes32', 'bytes32'],
    [
      encodeAuthorizationList(tx.authorizationList, raw.authorizationList),
      tx.signature.yParity,
      tx.signature.r,
      tx.signature.s,
    ],
  );

  // Chunk 4: Receipt fields
  const chunk4 = encodeReceiptFields(rx);

  return [chunk1, chunk2, chunk3, chunk4];
}

function getTypesForType(txType: number): string[] {
  switch (txType) {
    case 0:
      // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
      // Chunk 2: Type-specific fields (gasPrice, v, r, s)
      // Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
      return [
        'uint64',
        'uint64',
        'address',
        'bool',
        'address',
        'uint256',
        'bytes',
        'uint128',
        'uint256',
        'bytes32',
        'bytes32',
        'uint8',
        'uint64',
        'tuple(address, bytes32[], bytes)[]',
        'bytes',
      ];
    case 1:
      // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
      // Chunk 2: Type-specific fields (chainId, gasPrice, accessList, yParity, r, s)
      // Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
      return [
        'uint64',
        'uint64',
        'address',
        'bool',
        'address',
        'uint256',
        'bytes',
        'uint64',
        'uint128',
        'tuple(address,bytes32[])[]',
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'uint64',
        'tuple(address, bytes32[], bytes)[]',
        'bytes',
      ];
    case 2:
      // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
      // Chunk 2: Type-specific fields (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList, yParity, r, s)
      // Chunk 3: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
      return [
        'uint64',
        'uint64',
        'address',
        'bool',
        'address',
        'uint256',
        'bytes',
        'uint64',
        'uint128',
        'uint128',
        'tuple(address,bytes32[])[]',
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'uint64',
        'tuple(address, bytes32[], bytes)[]',
        'bytes',
      ];
    case 3:
      // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
      // Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
      // Chunk 3: Type-specific fields part 2 (maxFeePerChunkGas, blobVersionedHashes, yParity, r, s)
      // Chunk 4: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
      return [
        'uint64',
        'uint64',
        'address',
        'bool',
        'address',
        'uint256',
        'bytes',
        'uint64',
        'uint128',
        'uint128',
        'tuple(address,bytes32[])[]',
        'uint256',
        'bytes32[]',
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'uint64',
        'tuple(address, bytes32[], bytes)[]',
        'bytes',
      ];
    case 4:
      // Chunk 1: Common fields (nonce, gasLimit, from, toIsNull, to, value, data)
      // Chunk 2: Type-specific fields part 1 (chainId, maxPriorityFeePerGas, maxFeePerGas, accessList)
      // Chunk 3: Type-specific fields part 2 (authorizationList, yParity, r, s)
      // Chunk 4: Receipt fields (receiptStatus, receiptGasUsed, receiptLogs, receiptLogsBloom)
      return [
        'uint64',
        'uint64',
        'address',
        'bool',
        'address',
        'uint256',
        'bytes',
        'uint64',
        'uint128',
        'uint128',
        'tuple(address,bytes32[])[]',
        'tuple(uint256,address,uint64,uint8,uint256,uint256)[]',
        'uint8',
        'bytes32',
        'bytes32',
        'uint8',
        'uint64',
        'tuple(address, bytes32[], bytes)[]',
        'bytes',
      ];
    default:
      throw new Error(`Unsupported transaction type: ${txType}`);
  }
}

/**
 * Selects the appropriate chunk creation function based on transaction type
 */
function getChunksForType(tx: TransactionWithRaw, rx: TransactionReceipt): string[] {
  switch (tx.formatted.type) {
    case 0:
      return getChunksForType0(tx.formatted, rx);
    case 1:
      return getChunksForType1(tx.formatted, rx);
    case 2:
      return getChunksForType2(tx.formatted, rx);
    case 3:
      return getChunksForType3(tx.formatted, rx);
    case 4:
      // Only Type 4 uses authorization list so it's the only one that needs tx.raw
      return getChunksForType4(tx.formatted, tx.raw, rx);
    default:
      throw new Error(`Unsupported transaction type: ${tx.formatted.type}`);
  }
}

/**
 * Encodes transaction and receipt data into ABI-encoded bytes[] format
 *
 * The output `abi` string is raw ABI-encoded data (not a function call).
 * To decode it:
 * - Type: `bytes[]`
 * - Data: the `abi` string (make sure it has 0x prefix if required by decoder)
 *
 * Note: Some online decoders may have issues with raw ABI-encoded bytes[] arrays.
 * For programmatic decoding, see the investigation utilities in investigate.ts.
 *
 * @param tx - Transaction response
 * @param rx - Transaction receipt
 * @returns Object containing the encoded abi string and the types array
 */
export function abiEncode(tx: TransactionWithRaw, rx: TransactionReceipt): EncodingResult {
  // Create chunks using explicit chunk creation (super explicit - no intermediate steps)
  const chunks = getChunksForType(tx, rx);

  // Build flat types array from chunk configuration for QueryBuilder compatibility
  const types = getTypesForType(tx.formatted.type);

  // Encode as (uint8, bytes[]) where uint8 is the transaction type
  // This makes it easy to extract the type without full decoding
  // QueryBuilder needs to understand this structure to calculate offsets
  const coder = AbiCoder.defaultAbiCoder();
  const abi = coder.encode(['uint8', 'bytes[]'], [tx.formatted.type, chunks]);

  return {
    types, // Flat types for QueryBuilder to understand field grouping
    abi, // (uint8, bytes[]) format - this is what gets stored and attested to
  };
}
