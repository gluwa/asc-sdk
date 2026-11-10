# Attestcoin SDK (TypeScript)

[![Tests](https://github.com/gluwa/attestcoin-sdk-ts/actions/workflows/unit-tests.yaml/badge.svg)](https://github.com/gluwa/attestcoin-sdk-ts/actions/workflows/unit-tests.yaml)
[![npm version](https://img.shields.io/npm/v/@gluwa/attestcoin-sdk)](https://www.npmjs.com/package/@gluwa/attestcoin-sdk)

SDK for JS/TS used for interacting with the Attestcoin ecosystem on the CTC chain through a variety of tools. To
use it simply add the following package to your dependencies:

```sh
npm install @gluwa/attestcoin-sdk
```

or with yarn

```sh
yarn add @gluwa/attestcoin-sdk
```

**IMPORTANT:** all examples receive their input from environment variables.
You have to define these values before executing them:

- `CREDITCOIN_RPC_URL` - string - the URL to the CTC chain,
  for example `https://rpc.cc3-testnet.creditcoin.network`
- `CREDITCOIN_PROOF_BUILDER_URL` - string - the URL to the CTC Proof Builder service,
  for example `https://prover.cc3-testnet.creditcoin.network/`
- `SOURCE_CHAIN_KEY` - number - unique identifier of the source chain, e.g. Ethereum,
  on the CTC chain. NOTE: this is different than `chainId`!
- `SOURCE_CHAIN_BLOCK_HEIGHT` - number - the block height on the source chain, e.g. Ethereum,
  you are trying to inspect
- `SOURCE_CHAIN_TXN_HASH` - string - a transaction hash on the source chain, e.g. Ethereum,
  you are trying to generate a proof for

## Transaction verification

For verifying transaction inclusion the library has a series of components used to generate and validate inclusion proofs along with helper tools for tracking supported source
chains from which transactions can be proven along with helpers for keeping track of block attestation and supported chain state on the targeted CTC chain.

### Supported chains and attestation information

The `PrecompileChainInfoProvider` interacts with CTC network's ChainInfo precompile
contract to retrieve information about supported chains, attestation data, and
continuity bounds. This component is essential for understanding the current
state of cross-chain attestations. See
[examples/supported-chains-attestation-information.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/examples/supported-chains-attestation-information.ts).

### Proof building

The `ProofBuilder` provides a convenient way to build proofs by
communicating with a remote dedicate service for it. This component handles
HTTP communication and provides a clean interface for fetching pre-computed proofs.
See
[examples/proof-generation.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/examples/proof-generation.ts).

### Proof validation

The `PrecompileBlockProver` provides on-chain verification capabilities for
transaction proofs. It can verify both single transactions and batches of
transactions using Merkle proofs and continuity proofs. See
[examples/proof-validation.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/examples/proof-validation.ts).

### Batch proof generation and validation

When working with multiple transactions at the same time you can use
`ProofBuilder.getBatchProof()` and
`PrecompileBlockProver.verifyBatch()` to generate and verify batch proofs
instead of iterating over each transaction one at a time. See
[examples/batch-proof-validation.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/examples/batch-proof-validation.ts).

### Complete end to end example

Here's an example showing how to use the proof generator components together:
[examples/end-to-end.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/examples/end-to-end.ts).

## Transaction encoding

`encoding.abiEncode(input, version)` turns a transaction and its receipt into the Merkle leaf that gets attested.
The `kind` of the input selects the leaf layout:

```ts
import { encoding } from '@gluwa/attestcoin-sdk';

// Ethereum transaction types 0-4 (also the non-deposit transactions of an OP-Stack block)
const leaf = encoding.abiEncode({ kind: 'ethereum', tx: txWithRaw, rx: receipt });

// OP-Stack deposit (type 0x7e, e.g. Base or OP Mainnet)
const depositLeaf = encoding.abiEncode({ kind: 'opDeposit', tx: deposit, rx: receipt });
```

ethers cannot represent the OP-Stack `0x7e` deposit type, so deposits use `encoding.opStack.DepositTransaction`
and parsing it out of an RPC response is up to the caller. Set its `nonce` with
`encoding.opStack.canonicalNonce({ depositNonce, depositReceiptVersion })`: the receipt's `depositNonce` from Canyon
onward, zero before, because neither header root commits to the RPC nonce before Canyon.
`encoding.opStack.computedHash(deposit)` reproduces the transaction hash, which lets you check an RPC-reported hash
against the fields you parsed. The leaf layout (`txType = 126`, three chunks) is documented in
[src/encoding/abi/op-stack/index.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/src/encoding/abi/op-stack/index.ts).
The Query Builder has no `0x7e` field mapping yet, so deposits cannot be queried field by field.

## Query Builder

The `QueryBuilder` is used to extract result segments from transactions which
can be used to validate their contents. See
[tests/smoke/query.builder.test.ts](https://github.com/gluwa/attestcoin-sdk-ts/blob/main/tests/smoke/query.builder.test.ts)
for more context.

The `Query Builder should be able to build a query` and `Build query from transactions with multiple events`
test scenarios - show how to:

- Create a query builder
- Use `.setAbiProvider()` to specify a ABI for a smart contract(s) to decode various calldata and events
  related to the contract
- Use `.addStaticField()` to query specific fields from the transaction, e.g. `TxFrom`, `TxTo`, `RxStatus`
- Use `.eventBuilder()` to query for specific events and fields inside these events
- Use `.addFunctionSignature()` and `.addFunctionArgument()` to query for specific arguments
  passed as calldata
- Call `.build()` to build the query and return the result segments fields which can be interrogated later
