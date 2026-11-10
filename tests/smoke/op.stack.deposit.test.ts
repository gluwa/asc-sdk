// Leaf encoding of OP-Stack `0x7e` deposit transactions. Offline: see `tests/fixtures/README.md`.
import { test, expect, describe } from '@jest/globals';
import { AbiCoder, getAddress, hexlify, toBigInt, ZeroAddress } from 'ethers';
import { abiEncode, EncodingVersion, opStack } from '../../src/encoding/abi';
import type { DepositReceipt, DepositTransaction } from '../../src/encoding/abi';

import baseSepolia from '../fixtures/deposit_base_sepolia_46388021.json';
import opMainnet from '../fixtures/deposit_op_mainnet_110000000.json';
import { readFileSync } from 'fs';
import path from 'path';

const readLeaf = (name: string): string =>
  '0x' + readFileSync(path.join(__dirname, '../fixtures', name), 'utf8').trim();
const BASE_SEPOLIA_LEAF = readLeaf('deposit_base_sepolia_46388021_leaf.hex');
const OP_MAINNET_LEAF = readLeaf('deposit_op_mainnet_110000000_leaf.hex');

interface Fixture {
  tx: DepositTransaction;
  rx: DepositReceipt;
  rpcNonce: bigint;
}

/** What a caller does with an RPC response: read the deposit fields, canonicalize the nonce. */
function load(json: typeof baseSepolia | typeof opMainnet): Fixture {
  const { tx, receipt } = json;
  const fields = receipt as { depositNonce?: string; depositReceiptVersion?: string };
  const nonce = opStack.canonicalNonce({
    depositNonce: fields.depositNonce == null ? null : toBigInt(fields.depositNonce),
    depositReceiptVersion: fields.depositReceiptVersion == null ? null : toBigInt(fields.depositReceiptVersion),
  });
  return {
    tx: {
      hash: tx.hash,
      sourceHash: tx.sourceHash,
      from: tx.from,
      to: tx.to,
      mint: toBigInt(tx.mint),
      value: toBigInt(tx.value),
      gasLimit: toBigInt(tx.gas),
      isSystemTx: false,
      input: tx.input,
      nonce,
    },
    rx: {
      status: Number(receipt.status),
      gasUsed: toBigInt(receipt.gasUsed),
      logsBloom: receipt.logsBloom,
      logs: receipt.logs,
    },
    rpcNonce: toBigInt(tx.nonce),
  };
}

const encode = (tx: DepositTransaction, rx: DepositReceipt) =>
  abiEncode({ kind: 'opDeposit', tx, rx }, EncodingVersion.V1);

/** Splits a leaf into `[txType, decoded chunks]`: common, deposit, receipt. */
function decode(leaf: string): [bigint, any[][]] {
  const coder = AbiCoder.defaultAbiCoder();
  const [txType, rawChunks] = coder.decode(['uint8', 'bytes[]'], leaf);
  const types = [
    ['uint64', 'uint64', 'address', 'bool', 'address', 'uint256', 'bytes'],
    ['bytes32', 'uint256', 'bool'],
    ['uint8', 'uint64', 'tuple(address, bytes32[], bytes)[]', 'bytes'],
  ];
  expect(rawChunks).toHaveLength(types.length);
  const chunks = (rawChunks as string[]).map((raw, i) => [...coder.decode(types[i], raw)]);
  return [txType, chunks];
}

describe('OP-Stack deposit leaf', () => {
  test('deposit hash is reproduced by our 2718 encoding', () => {
    for (const json of [baseSepolia, opMainnet]) {
      const { tx } = load(json);
      expect(opStack.computedHash(tx)).toBe(tx.hash);
    }
  });

  test('canyon deposit leaf matches reference bytes', () => {
    const { tx, rx } = load(baseSepolia);
    expect(tx.nonce).toBe(46_388_024n);
    expect(encode(tx, rx).abi).toBe(BASE_SEPOLIA_LEAF);
  });

  test('pre-canyon deposit leaf matches reference bytes and uses zero nonce', () => {
    const { tx, rx, rpcNonce } = load(opMainnet);
    // The RPC reports a nonce, but no header root commits to it: the leaf must not use it.
    expect(rpcNonce).not.toBe(0n);
    expect(tx.nonce).toBe(0n);

    const { abi } = encode(tx, rx);
    expect(abi).toBe(OP_MAINNET_LEAF);
    const [, chunks] = decode(abi);
    expect(chunks[0][0]).toBe(0n);
  });

  test('leaf decodes into documented layout', () => {
    const { tx, rx } = load(baseSepolia);
    const result = encode(tx, rx);
    const [txType, chunks] = decode(result.abi);

    expect(txType).toBe(BigInt(opStack.DEPOSIT_TX_TYPE));
    expect(txType).toBe(126n);

    const [common, deposit, receipt] = chunks;
    expect(common[0]).toBe(tx.nonce);
    expect(common[1]).toBe(tx.gasLimit);
    expect(common[2]).toBe(getAddress(tx.from));
    expect(common[3]).toBe(false);
    expect(common[4]).toBe(getAddress(tx.to!));
    expect(common[5]).toBe(tx.value);
    expect(common[6]).toBe(tx.input);

    expect(deposit[0]).toBe(tx.sourceHash);
    expect(deposit[1]).toBe(tx.mint);
    expect(deposit[2]).toBe(false);

    expect(receipt[0]).toBe(1n);
    expect(receipt[1]).toBe(rx.gasUsed);
    expect(receipt[2]).toHaveLength(0);

    // `types` is the flat field list across the three chunks, as for the Ethereum layouts.
    expect(result.types).toHaveLength(common.length + deposit.length + receipt.length);
  });

  // A user deposit (not the L1-attributes one): contract creation, minted ETH, a log.
  test('contract creation, mint and logs are encoded', () => {
    const { tx: base, rx: baseRx } = load(baseSepolia);
    const tx: DepositTransaction = {
      ...base,
      to: null,
      mint: 1_000_000n,
      value: 7n,
      isSystemTx: true,
      input: '0x6080',
    };
    const logAddress = getAddress('0x1111111111111111111111111111111111111111');
    const topic = hexlify(new Uint8Array(32).fill(0xab));
    const rx: DepositReceipt = {
      ...baseRx,
      logs: [{ address: logAddress, topics: [topic], data: '0xdeadbeef' }],
    };

    const [, chunks] = decode(encode(tx, rx).abi);
    const [common, deposit, receipt] = chunks;
    expect(common[3]).toBe(true); // toIsNull
    expect(common[4]).toBe(ZeroAddress);
    expect(common[5]).toBe(7n);
    expect(common[6]).toBe('0x6080');
    expect(deposit[1]).toBe(1_000_000n);
    expect(deposit[2]).toBe(true);
    expect(receipt[2]).toHaveLength(1);
    const [log] = receipt[2];
    expect([log[0], [...log[1]], log[2]]).toEqual([logAddress, [topic], '0xdeadbeef']);
  });

  test('2718 encoding handles zero fields and contract creation', () => {
    const { tx } = load(baseSepolia);
    // `0x7e || rlp([...])`, with `to` as the empty string for a creation.
    const create = opStack.encode2718({ ...tx, to: null });
    expect(create.startsWith('0x7e')).toBe(true);
    expect(create).not.toBe(opStack.encode2718(tx));
    expect(opStack.computedHash({ ...tx, isSystemTx: true })).not.toBe(opStack.computedHash(tx));
  });

  test('canonical nonce rules', () => {
    const nonce = (depositNonce: bigint | null, depositReceiptVersion: bigint | null) =>
      opStack.canonicalNonce({ depositNonce, depositReceiptVersion });
    // Pre-Canyon: unavailable, regardless of provider metadata.
    expect(nonce(null, null)).toBe(0n);
    expect(nonce(9n, null)).toBe(0n);
    // Canyon and later: the receipt-authenticated nonce.
    expect(nonce(9n, 1n)).toBe(9n);
    // A versioned receipt without a nonce is malformed.
    expect(() => nonce(null, 1n)).toThrow(opStack.MissingDepositNonceError);
  });
});
