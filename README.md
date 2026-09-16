# Creditcoin's Universal Smart Contract SDK

SDK for JS/TS used for interacting with the Creditcoin network through a variety of tools. To
use it simply add the following package to your dependencies:

```sh
npm install @gluwa/asc-sdk
```

or with yarn

```sh
yarn add @gluwa/asc-sdk
```

**IMPORTANT:** all examples receive their input from environment variables.
You have to define these values before executing them:

- `CREDITCOIN_RPC_URL` - string - the URL to the Creditcoin chain,
  for example `https://rpc.cc3-testnet.creditcoin.network`
- `CREDITCOIN_PROOF_BUILDER_URL` - string - the URL to the Creditcoin Proof Builder service,
  for example `https://prover.cc3-testnet.creditcoin.network/`
- `SOURCE_CHAIN_KEY` - number - unique identifier of the source chain, e.g. Ethereum,
  on the Creditcoin chain. NOTE: this is different than `chainId`!
- `SOURCE_CHAIN_BLOCK_HEIGHT` - number - the block height on the source chain, e.g. Ethereum,
  you are trying to inspect
- `SOURCE_CHAIN_TXN_HASH` - string - a transaction hash on the source chain, e.g. Ethereum,
  you are trying to generate a proof for

## Transaction verification

For verifying transaction inclusion the library has a series of components used to generate and validate inclusion proofs along with helper tools for tracking supported source
chains from which transactions can be proven along with helpers for keeping track of block attestation and supported chain state on the targeted Creditcoin chain.

### Supported chains and attestation information

The `PrecompileChainInfoProvider` interacts with Creditcoin's ChainInfo precompile
contract to retrieve information about supported chains, attestation data, and
continuity bounds. This component is essential for understanding the current
state of cross-chain attestations. See
[examples/supported-chains-attestation-information.ts](https://github.com/gluwa/asc-sdk/blob/main/examples/supported-chains-attestation-information.ts).

### Proof building

The `ProofBuilder` provides a convenient way to build proofs by
communicating with a remote dedicate service for it. This component handles
HTTP communication and provides a clean interface for fetching pre-computed proofs.
See
[examples/proof-generation.ts](https://github.com/gluwa/asc-sdk/blob/main/examples/proof-generation.ts).

### Proof validation

The `PrecompileBlockProver` provides on-chain verification capabilities for
transaction proofs. It can verify both single transactions and batches of
transactions using Merkle proofs and continuity proofs. See
[examples/proof-validation.ts](https://github.com/gluwa/asc-sdk/blob/main/examples/proof-validation.ts).

### Batch proof generation and validation

When working with multiple transactions at the same time you can use
`ProofBuilder.getBatchProof()` and
`PrecompileBlockProver.verifyBatch()` to generate and verify batch proofs
instead of iterating over each transaction one at a time. See
[examples/batch-proof-validation.ts](https://github.com/gluwa/asc-sdk/blob/main/examples/batch-proof-validation.ts).

### Complete end to end example

Here's an example showing how to use the proof generator components together:
[examples/end-to-end.ts](https://github.com/gluwa/asc-sdk/blob/main/examples/end-to-end.ts).

## Query Builder

The `QueryBuilder` is used to extract result segments from transactions which
can be used to validate their contents. See
[tests/smoke/query.builder.test.ts](https://github.com/gluwa/asc-sdk/blob/main/tests/smoke/query.builder.test.ts)
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
