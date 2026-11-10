import { test, expect } from '@jest/globals';
import { hexlify, JsonRpcProvider, Log, LogDescription, ZeroAddress } from 'ethers';
import { abiEncode } from '../../src/encoding/abi';
import { QueryBuilder } from '../../src/query-builder/abi/QueryBuilder';
import { QueryableFields } from '../../src/query-builder/abi/models';
import { ForkedReader } from '../../src/query-builder/common/ForkedReader';
import { ERC20_BURN_ABI, LOAN_PAYMENT_ABI } from '../common/const';
import { getTransactionWithRaw } from '../../src/encoding/common';

test('Transaction yParity check', async () => {
  const rpc = 'https://sepolia-proxy-rpc.creditcoin.network';
  const provider = new JsonRpcProvider(rpc);

  const transactionHashes = [
    '0x39dfab8a4143253e7b9c2d87845bd57ee2e01187b68599c3652e359174bafb25',
    '0x5a68c9ff8f627b95e8326c909ba853bf831b558668c6521f80fc3af448a0947f',
    '0xa56d8e39403418d40435a5217ae5434a138f3dfd641367a4f8aba7a235ee49b0',
    '0xb8cf2e7b8be95b31b65d278b3703cf60e4bbf46193aa40d2bf5b991aad048e69',
    '0x87f52be065ab3343b66923652eca76d01245e726975c87ff04480d5dc8a4df8a',
  ];

  for (const txHash of transactionHashes) {
    const transaction = await getTransactionWithRaw(provider, txHash);

    expect(transaction !== null).toBe(true);
    expect(transaction!.formatted.authorizationList?.length).toBe(1);
    expect(transaction!.raw.authorizationList?.length).toBe(1);

    const formattedYParity = transaction!.formatted.authorizationList?.[0].signature.yParity;
    const rawYParity = transaction!.raw.authorizationList?.[0].yParity;

    expect(formattedYParity).toBe(0);
    expect(rawYParity).toBe(27);
  }
}, 20_000);

test('Query Builder should be able to build a query', async () => {
  const rpc = 'https://sepolia-proxy-rpc.creditcoin.network';
  const provider = new JsonRpcProvider(rpc);

  // ERC20 Burn
  const transactionHash = '0xc990ce703dd3ca83429c302118f197651678de359c271f205b9083d4aa333aae'; //"0x0b50111d729c00bac4a99702b2c88e425321c8f8214bc3272072c730d5ff9ad2";
  const transaction = await getTransactionWithRaw(provider, transactionHash);
  const receipt = await provider.getTransactionReceipt(transactionHash);
  const builder = QueryBuilder.createFromTransaction(transaction!, receipt!);
  const abiEncoded = abiEncode({ kind: 'ethereum', tx: transaction!, rx: receipt! });

  builder.setAbiProvider(async (contractAddress) => {
    return JSON.stringify(ERC20_BURN_ABI);
  });

  const burnTransferFilter = (log: Log, logDescription: LogDescription, _: number) => {
    if (logDescription.topic != '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') return false;

    if (log.address.toLowerCase() != '0x47C30768E4c153B40d55b90F58472bb2291971e6'.toLowerCase()) return false;

    return (
      logDescription.args.from.toLowerCase() == '0x9d6bC9763008AD1F7619a3498EfFE9Ec671b276D'.toLowerCase() &&
      logDescription.args.to.toLowerCase() == ZeroAddress.toLowerCase()
    );
  };

  // Format
  // 0 - RxStatus
  // 1 - TxFrom
  // 2 - TxTo
  // 3 - (Event)Transfer Signature
  // 4 - (Event) Transfer From
  // 5 - (Event) Transfer To
  // 6 - (Event) Transfer Value
  // 7 - (Function) Function Signature
  // 8 - (Function) Function Value
  builder
    .addStaticField(QueryableFields.RxStatus)
    .addStaticField(QueryableFields.TxFrom)
    .addStaticField(QueryableFields.TxTo);
  await builder.eventBuilder('Transfer', burnTransferFilter, (b) =>
    b.addSignature().addArgument('from').addArgument('to').addArgument('value'),
  );
  builder.addFunctionSignature();
  await builder.addFunctionArgument('burn', 'value');

  const fields = builder.build();

  const reader = new ForkedReader(abiEncoded.abi);

  // Assert field structure
  expect(fields.length).toBe(9);
  expect(fields[0].offset).toBe(736);
  expect(fields[0].size).toBe(32);
  expect(fields[1].offset).toBe(288);
  expect(fields[1].size).toBe(32);
  expect(fields[2].offset).toBe(352);
  expect(fields[2].size).toBe(32);
  expect(fields[3].offset).toBe(1344);
  expect(fields[3].size).toBe(32);
  expect(fields[4].offset).toBe(1376);
  expect(fields[4].size).toBe(32);
  expect(fields[5].offset).toBe(1408);
  expect(fields[5].size).toBe(32);
  expect(fields[6].offset).toBe(1472);
  expect(fields[6].size).toBe(32);
  expect(fields[7].offset).toBe(480);
  expect(fields[7].size).toBe(4);
  expect(fields[8].offset).toBe(484);
  expect(fields[8].size).toBe(32);

  // Assert the actual data values from console output

  // Field 0: RxStatus (offset 352, size 32) - should be 0x0000000000000000000000000000000000000000000000000000000000000001
  reader.jumpTo(fields[0].offset);
  const field0Data = reader.readBytes(fields[0].size);
  expect(hexlify(field0Data)).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');

  // Field 1: TxFrom (offset 128, size 32) - should be 0x0000000000000000000000009d6bc9763008ad1f7619a3498effe9ec671b276d
  reader.jumpTo(fields[1].offset);
  const field1Data = reader.readBytes(fields[1].size);
  expect(hexlify(field1Data)).toBe('0x0000000000000000000000009d6bc9763008ad1f7619a3498effe9ec671b276d');

  // Field 2: TxTo (offset 160, size 32) - should be 0x00000000000000000000000047c30768e4c153b40d55b90f58472bb2291971e6
  reader.jumpTo(fields[2].offset);
  const field2Data = reader.readBytes(fields[2].size);
  expect(hexlify(field2Data)).toBe('0x00000000000000000000000047c30768e4c153b40d55b90f58472bb2291971e6');

  // Field 3: Transfer Signature (offset 1056, size 32) - should be 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  reader.jumpTo(fields[3].offset);
  const field3Data = reader.readBytes(fields[3].size);
  expect(hexlify(field3Data)).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');

  // Field 4: Transfer From (offset 1088, size 32) - should be 0x0000000000000000000000009d6bc9763008ad1f7619a3498effe9ec671b276d
  reader.jumpTo(fields[4].offset);
  const field4Data = reader.readBytes(fields[4].size);
  expect(hexlify(field4Data)).toBe('0x0000000000000000000000009d6bc9763008ad1f7619a3498effe9ec671b276d');

  // Field 5: Transfer To (offset 1120, size 32) - should be 0x0000000000000000000000000000000000000000000000000000000000000000
  reader.jumpTo(fields[5].offset);
  const field5Data = reader.readBytes(fields[5].size);
  expect(hexlify(field5Data)).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');

  // Field 6: Transfer Value (offset 1184, size 32) - should be 0x0000000000000000000000000000000000000000000000000de0b6b3a7640000
  reader.jumpTo(fields[6].offset);
  const field6Data = reader.readBytes(fields[6].size);
  expect(hexlify(field6Data)).toBe('0x0000000000000000000000000000000000000000000000000de0b6b3a7640000');

  // Field 7: Function Signature (offset 512, size 4) - should be 0x42966c68
  reader.jumpTo(fields[7].offset);
  const field7Data = reader.readBytes(fields[7].size);
  expect(hexlify(field7Data)).toBe('0x42966c68');

  // Field 8: Function Value (offset 516, size 32) - should be 0x0000000000000000000000000000000000000000000000000de0b6b3a7640000
  reader.jumpTo(fields[8].offset);
  const field8Data = reader.readBytes(fields[8].size);
  expect(hexlify(field8Data)).toBe('0x0000000000000000000000000000000000000000000000000de0b6b3a7640000');
});

test('Build query from transactions with multiple events', async () => {
  const rpc = 'https://sepolia-proxy-rpc.creditcoin.network';
  const provider = new JsonRpcProvider(rpc);

  const transactionHash = '0x202b9b1d689578cf7dd7b279b3c9cb02f47cef7b44b6fa1650ab67977f86cb11'; //"0x0b50111d729c00bac4a99702b2c88e425321c8f8214bc3272072c730d5ff9ad2";
  const transaction = await getTransactionWithRaw(provider, transactionHash);
  const receipt = await provider.getTransactionReceipt(transactionHash);
  const builder = QueryBuilder.createFromTransaction(transaction!, receipt!);
  const abiEncoded = abiEncode({ kind: 'ethereum', tx: transaction!, rx: receipt! });

  builder.setAbiProvider(async (contractAddress) => {
    switch (contractAddress.toLowerCase()) {
      case '0x296077f69435a073f7A6E0CBAEf8C1877633832E'.toLowerCase():
        return JSON.stringify(ERC20_BURN_ABI);
      case '0x39DE412201f2446b3606C93dFB799EdE6a721b13'.toLowerCase():
        return JSON.stringify(LOAN_PAYMENT_ABI);
      default:
        throw new Error(`Unknown contract address: ${contractAddress}`);
    }
  });
  // 0: Rx - Status (from addStaticField(RxStatus))
  // 1: Tx - From (from addStaticField(TxFrom))
  // 2: Tx - To (from addStaticField(TxTo))
  builder
    .addStaticField(QueryableFields.RxStatus)
    .addStaticField(QueryableFields.TxFrom)
    .addStaticField(QueryableFields.TxTo);

  // For AUX loan events
  // 3: Loan Event - Address (contract emitting RepayLoan)
  // 4: Loan Event - Signature
  // 5: Loan Event - loanHash (unique identifier for the loan)
  await builder.eventBuilder(
    'RepayLoan',
    () => true,
    (b) => b.addAddress().addSignature().addArgument('loanHash'),
  );

  // For ERC20 transfers events
  // 6: Transfer Event - Address (contract emitting Transfer)
  // 7: Transfer Event - Signature
  // 8: Transfer Event - from (address sending the tokens)
  // 9: Transfer Event - to (address receiving the tokens)
  // 10: Transfer Event - value (amount of tokens transferred)
  await builder.eventBuilder(
    'Transfer',
    () => true,
    (b) => b.addAddress().addSignature().addArgument('from').addArgument('to').addArgument('value'),
  );

  const fields = builder.build();

  const reader = new ForkedReader(abiEncoded.abi);
  // Assert field structure
  expect(fields.length).toBe(11);
  expect(fields[0].offset).toBe(928);
  expect(fields[0].size).toBe(32);
  expect(fields[1].offset).toBe(288);
  expect(fields[1].size).toBe(32);
  expect(fields[2].offset).toBe(352);
  expect(fields[2].size).toBe(32);
  expect(fields[3].offset).toBe(1440);
  expect(fields[3].size).toBe(32);
  expect(fields[4].offset).toBe(1568);
  expect(fields[4].size).toBe(32);
  expect(fields[5].offset).toBe(1632);
  expect(fields[5].size).toBe(32);
  expect(fields[6].offset).toBe(1152);
  expect(fields[6].size).toBe(32);
  expect(fields[7].offset).toBe(1280);
  expect(fields[7].size).toBe(32);
  expect(fields[8].offset).toBe(1312);
  expect(fields[8].size).toBe(32);
  expect(fields[9].offset).toBe(1344);
  expect(fields[9].size).toBe(32);
  expect(fields[10].offset).toBe(1408);
  expect(fields[10].size).toBe(32);

  // Assert the actual data values from console output

  // Field 0: RxStatus (offset 448, size 32) - should be 0x0000000000000000000000000000000000000000000000000000000000000001
  reader.jumpTo(fields[0].offset);
  const field0Data = reader.readBytes(fields[0].size);
  expect(hexlify(field0Data)).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');

  // Field 1: TxFrom (offset 192, size 32) - should be 0x0000000000000000000000002fabaffc7f6426c1beedec22cc150a7dbe6667fb
  reader.jumpTo(fields[1].offset);
  const field1Data = reader.readBytes(fields[1].size);
  expect(hexlify(field1Data)).toBe('0x0000000000000000000000002fabaffc7f6426c1beedec22cc150a7dbe6667fb');

  // Field 2: TxTo (offset 224, size 32) - should be 0x00000000000000000000000039de412201f2446b3606c93dfb799ede6a721b13
  reader.jumpTo(fields[2].offset);
  const field2Data = reader.readBytes(fields[2].size);
  expect(hexlify(field2Data)).toBe('0x00000000000000000000000039de412201f2446b3606c93dfb799ede6a721b13');

  // Field 3: Loan Event Address (offset 1152, size 32) - should be 0x00000000000000000000000039de412201f2446b3606c93dfb799ede6a721b13
  reader.jumpTo(fields[3].offset);
  const field3Data = reader.readBytes(fields[3].size);
  expect(hexlify(field3Data)).toBe('0x00000000000000000000000039de412201f2446b3606c93dfb799ede6a721b13');

  // Field 4: Loan Event Signature (offset 1280, size 32) - should be 0x573e759e6d2d7f0706fd825699c62290a3b275b297dc5cda4a96856a251d00a0
  reader.jumpTo(fields[4].offset);
  const field4Data = reader.readBytes(fields[4].size);
  expect(hexlify(field4Data)).toBe('0x573e759e6d2d7f0706fd825699c62290a3b275b297dc5cda4a96856a251d00a0');

  // Field 5: Loan Event loanHash (offset 1344, size 32) - should be 0xaf840a790d0056fa2c551a54a9b845e8f427107fe6570c41d89ecfe396d32f98
  reader.jumpTo(fields[5].offset);
  const field5Data = reader.readBytes(fields[5].size);
  expect(hexlify(field5Data)).toBe('0xaf840a790d0056fa2c551a54a9b845e8f427107fe6570c41d89ecfe396d32f98');

  // Field 6: Transfer Event Address (offset 864, size 32) - should be 0x000000000000000000000000296077f69435a073f7a6e0cbaef8c1877633832e
  reader.jumpTo(fields[6].offset);
  const field6Data = reader.readBytes(fields[6].size);
  expect(hexlify(field6Data)).toBe('0x000000000000000000000000296077f69435a073f7a6e0cbaef8c1877633832e');

  // Field 7: Transfer Event Signature (offset 992, size 32) - should be 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  reader.jumpTo(fields[7].offset);
  const field7Data = reader.readBytes(fields[7].size);
  expect(hexlify(field7Data)).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');

  // Field 8: Transfer Event from (offset 1024, size 32) - should be 0x0000000000000000000000002fabaffc7f6426c1beedec22cc150a7dbe6667fb
  reader.jumpTo(fields[8].offset);
  const field8Data = reader.readBytes(fields[8].size);
  expect(hexlify(field8Data)).toBe('0x0000000000000000000000002fabaffc7f6426c1beedec22cc150a7dbe6667fb');

  // Field 9: Transfer Event to (offset 1056, size 32) - should be 0x0000000000000000000000001c2ade017a8af7229ebab076f5c3db41a63fe422
  reader.jumpTo(fields[9].offset);
  const field9Data = reader.readBytes(fields[9].size);
  expect(hexlify(field9Data)).toBe('0x0000000000000000000000001c2ade017a8af7229ebab076f5c3db41a63fe422');

  // Field 10: Transfer Event value (offset 1120, size 32) - should be 0x0000000000000000000000000000000000000000000000000de0b7ffe3ae3825
  reader.jumpTo(fields[10].offset);
  const field10Data = reader.readBytes(fields[10].size);
  expect(hexlify(field10Data)).toBe('0x0000000000000000000000000000000000000000000000000de0b7ffe3ae3825');
});
