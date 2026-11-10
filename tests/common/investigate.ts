import { JsonRpcProvider, AbiCoder, ParamType, Interface, TransactionResponse, TransactionReceipt } from 'ethers';
import { abiEncode, EncodingVersion, QueryBuilder, QueryableFields, QueryBuilderForEvent } from '../../src/';
import { computeAbiOffsets } from '../../src/query-builder/abi/abi-utils';
import { computeAllOffsets } from '../../src/query-builder/abi/offset-utils';
import { getAllFieldsForTransaction } from '../../src/query-builder/abi/encoding-mapping';
import ERC20_ABI from '../abis/ERC20.json';
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

/**
 * Verification result tracker
 */
interface VerificationResult {
  name: string;
  passed: boolean;
  errors: string[];
  warnings: string[];
}

interface InvestigationContext {
  tx: TransactionResponse;
  receipt: TransactionReceipt;
  encodeResult: { types: string[]; abi: string };
  chunks: string[];
  dataBuffer: Buffer;
  verificationResults: VerificationResult[];
}

/**
 * Decodes the ABI-encoded (uint8, bytes[]) tuple back into individual chunks
 */
export function abiDecodeChunks(abi: string): string[] {
  const coder = AbiCoder.defaultAbiCoder();
  const decoded = coder.decode(['uint8', 'bytes[]'], abi);
  return decoded[1] as string[];
}

/**
 * Decodes a single chunk back into its constituent fields
 */
export function abiDecodeChunk(chunk: string, types: string[]): any[] {
  const coder = AbiCoder.defaultAbiCoder();
  const decoded = coder.decode(types, chunk);
  return Array.isArray(decoded) ? decoded : [decoded];
}

/**
 * Verifies transaction type encoding
 */
function verifyTransactionType(ctx: InvestigationContext): VerificationResult {
  const result: VerificationResult = {
    name: 'Transaction Type Encoding',
    passed: true,
    errors: [],
    warnings: [],
  };

  console.log('\n=== 1. Transaction Type Verification ===');

  const uint8Value = ctx.dataBuffer.readUInt8(31);
  const expectedType = ctx.tx.type;

  console.log(`   Expected transaction type: ${expectedType}`);
  console.log(`   uint8 value at offset 0-31: ${uint8Value}`);

  if (uint8Value !== expectedType) {
    result.passed = false;
    result.errors.push(`Transaction type mismatch: expected ${expectedType}, got ${uint8Value}`);
    console.log(`   ❌ Match: false`);
  } else {
    console.log(`   ✅ Match: true`);
  }

  return result;
}

/**
 * Verifies chunk decoding
 */
function verifyChunkDecoding(ctx: InvestigationContext): VerificationResult {
  const result: VerificationResult = {
    name: 'Chunk Decoding',
    passed: true,
    errors: [],
    warnings: [],
  };

  console.log('\n=== 2. Chunk Decoding Verification ===');
  console.log(`   Decoded ${ctx.chunks.length} chunk(s)\n`);

  const fieldMapping = getAllFieldsForTransaction(ctx.tx.type, EncodingVersion.V1);
  if (!fieldMapping.chunks) {
    result.passed = false;
    result.errors.push('Field mapping must use explicit chunks structure');
    return result;
  }

  if (fieldMapping.chunks.length !== ctx.chunks.length) {
    result.passed = false;
    result.errors.push(`Mismatch: expected ${fieldMapping.chunks.length} chunks, got ${ctx.chunks.length} chunks`);
    return result;
  }

  console.log(`   Note: type_ is encoded separately as the first uint8 parameter (not in chunks)\n`);

  for (let chunkIndex = 0; chunkIndex < fieldMapping.chunks.length; chunkIndex++) {
    const chunk = fieldMapping.chunks[chunkIndex];
    const chunkTypes = chunk.fields.map((f) => f.type);
    const fieldStart =
      chunkIndex === 0 ? 1 : fieldMapping.chunks.slice(0, chunkIndex).reduce((sum, c) => sum + c.fields.length, 0) + 1;
    const fieldEnd = fieldStart + chunk.fields.length - 1;

    console.log(`   Chunk ${chunkIndex + 1} (fields ${fieldStart}-${fieldEnd}):`);
    console.log(`     Types: [${chunkTypes.join(', ')}]`);
    console.log(`     Length: ${ctx.chunks[chunkIndex].length} chars (${ctx.chunks[chunkIndex].length / 2 - 1} bytes)`);
    console.log(`     Hex: ${ctx.chunks[chunkIndex].slice(0, 66)}...`);

    try {
      const decodedValues = abiDecodeChunk(ctx.chunks[chunkIndex], chunkTypes);
      console.log(`     ✅ Decoded successfully: ${decodedValues.length} values`);
      console.log(`     Values:`, decodedValues.map((v, i) => `${chunkTypes[i]}=${v}`).join(', '));
    } catch (error: any) {
      result.passed = false;
      result.errors.push(`Chunk ${chunkIndex + 1} failed to decode: ${error.message}`);
      console.log(`     ❌ Failed to decode: ${error.message}`);
    }
    console.log();
  }

  return result;
}

/**
 * Verifies chunk integrity (extracted vs decoded)
 */
function verifyChunkIntegrity(ctx: InvestigationContext): VerificationResult {
  const result: VerificationResult = {
    name: 'Chunk Integrity',
    passed: true,
    errors: [],
    warnings: [],
  };

  console.log('\n=== 3. Chunk Integrity Verification ===');

  const paramTypes = [ParamType.from('uint8'), ParamType.from('bytes[]')];
  const offsets = computeAbiOffsets(paramTypes, ctx.encodeResult.abi);

  if (!offsets || offsets.length < 2 || !offsets[1].children) {
    result.passed = false;
    result.errors.push('Failed to compute offsets for (uint8, bytes[]) structure');
    return result;
  }

  const chunkOffsets = offsets[1].children!;

  // Debug: Show structure
  console.log(`   Structure:`);
  console.log(`     [0] uint8 offset: ${offsets[0].offset}`);
  console.log(`     [1] bytes[] offset: ${offsets[1].offset}`);
  console.log(`     [1] bytes[] isDynamic: ${offsets[1].isDynamic}`);
  console.log(`     [1] bytes[] children (chunks): ${chunkOffsets.length}`);
  console.log();

  console.log(`   ✅ Computed offsets for ${chunkOffsets.length} chunk(s)\n`);

  // Debug: Show ABI encoding structure
  console.log(`   ABI encoding structure (first 128 bytes):`);
  console.log(`     Position 0x00-0x1F (uint8 value): ${ctx.dataBuffer.slice(0, 32).toString('hex')}`);
  console.log(`     Position 0x20-0x3F (offset to bytes[]): ${ctx.dataBuffer.slice(32, 64).toString('hex')}`);
  console.log(`     Position 0x40-0x5F (bytes[] length): ${ctx.dataBuffer.slice(64, 96).toString('hex')}`);
  console.log(`     Position 0x60-0x7F (first chunk offset): ${ctx.dataBuffer.slice(96, 128).toString('hex')}`);
  console.log();

  // Detailed offset breakdown
  console.log('   Detailed offset breakdown:\n');
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex++) {
    const chunkOffset = chunkOffsets[chunkIndex];
    console.log(`   Chunk ${chunkIndex + 1} offset details:`);
    console.log(`     Offset: ${chunkOffset.offset}`);
    console.log(`     Size: ${chunkOffset.size}`);
    console.log(`     Type: ${chunkOffset.type}`);

    // Try to read length at offset - 32 (where length prefix should be)
    const lengthPrefixOffset = chunkOffset.offset - 32;
    if (lengthPrefixOffset >= 0 && lengthPrefixOffset < ctx.dataBuffer.length) {
      const lengthPrefix = ctx.dataBuffer.slice(lengthPrefixOffset, lengthPrefixOffset + 32);
      const lengthValue = parseInt('0x' + lengthPrefix.toString('hex'), 16);
      console.log(`     Length prefix at offset ${lengthPrefixOffset}: ${lengthValue}`);
      console.log(`     Expected data size: ${lengthValue} bytes`);

      // Also check what's actually at the computed offset
      if (chunkOffset.offset < ctx.dataBuffer.length) {
        const actualDataStart = ctx.dataBuffer.slice(
          chunkOffset.offset,
          Math.min(chunkOffset.offset + 32, ctx.dataBuffer.length),
        );
        console.log(
          `     Actual data at offset ${chunkOffset.offset}: 0x${actualDataStart.toString('hex').slice(0, 64)}...`,
        );
      }
    }
    console.log();
  }

  // Verify integrity: extract chunk data at computed offsets and compare
  console.log('   Verifying integrity (extracting chunks at computed offsets)...\n');

  for (let chunkIndex = 0; chunkIndex < ctx.chunks.length; chunkIndex++) {
    const chunkOffset = chunkOffsets[chunkIndex];
    const decodedChunk = ctx.chunks[chunkIndex];

    console.log(`   Chunk ${chunkIndex + 1}:`);
    console.log(`     Computed offset: ${chunkOffset.offset}`);
    console.log(`     Computed size: ${chunkOffset.size}`);
    console.log(`     Decoded chunk length: ${decodedChunk.length} chars (${decodedChunk.length / 2 - 1} bytes)`);

    if (!chunkOffset.size || chunkOffset.size === 0) {
      result.passed = false;
      result.errors.push(`Chunk ${chunkIndex + 1}: Invalid size ${chunkOffset.size}`);
      console.log(`     ❌ Invalid size: ${chunkOffset.size}`);
      continue;
    }

    if (chunkOffset.offset + chunkOffset.size > ctx.dataBuffer.length) {
      result.passed = false;
      result.errors.push(`Chunk ${chunkIndex + 1}: Offset out of bounds`);
      console.log(
        `     ❌ Offset out of bounds: start=${chunkOffset.offset}, size=${chunkOffset.size}, bufferLength=${ctx.dataBuffer.length}`,
      );
      continue;
    }

    const extractedData = ctx.dataBuffer.slice(chunkOffset.offset, chunkOffset.offset + chunkOffset.size);
    const extractedHex = '0x' + extractedData.toString('hex');

    const decodedChunkNoPrefix = decodedChunk.startsWith('0x') ? decodedChunk.slice(2) : decodedChunk;
    const extractedHexNoPrefix = extractedHex.startsWith('0x') ? extractedHex.slice(2) : extractedHex;

    const matches = decodedChunkNoPrefix.toLowerCase() === extractedHexNoPrefix.toLowerCase();
    console.log(`     Extracted data: ${extractedHex.slice(0, 66)}...`);
    console.log(`     Decoded chunk:   ${decodedChunk.slice(0, 66)}...`);
    console.log(`     ${matches ? '✅' : '❌'} Match: ${matches}`);

    if (!matches) {
      result.passed = false;
      result.errors.push(`Chunk ${chunkIndex + 1}: Extracted data does not match decoded chunk`);
      console.log(`     ❌ MISMATCH DETECTED!`);
      console.log(`       Decoded:   ${decodedChunk.slice(0, 130)}...`);
      console.log(`       Extracted: ${extractedHex.slice(0, 130)}...`);
    }
    console.log();
  }

  return result;
}

/**
 * Verifies field-by-field offsets within chunks
 */
function verifyFieldOffsets(ctx: InvestigationContext): VerificationResult {
  const result: VerificationResult = {
    name: 'Field Offset Verification',
    passed: true,
    errors: [],
    warnings: [],
  };

  console.log('\n=== 4. Field Offset Verification ===');
  console.log(`   Note: type_ is encoded separately as the first uint8 parameter (not in chunks)\n`);

  const { computedOffsets: allComputedOffsets } = computeAllOffsets(ctx.tx, ctx.receipt, EncodingVersion.V1);
  const fieldMapping = getAllFieldsForTransaction(ctx.tx.type, EncodingVersion.V1);

  if (!fieldMapping.chunks) {
    result.passed = false;
    result.errors.push('Field mapping must use explicit chunks structure');
    return result;
  }

  const paramTypes = [ParamType.from('uint8'), ParamType.from('bytes[]')];
  const topLevelOffsets = computeAbiOffsets(paramTypes, ctx.encodeResult.abi);

  let offsetIndex = 0;
  let fieldMismatches = 0;

  for (let chunkIndex = 0; chunkIndex < fieldMapping.chunks.length; chunkIndex++) {
    const chunk = fieldMapping.chunks[chunkIndex];
    const chunkTypes = chunk.fields.map((f) => f.type);
    const chunkHex = ctx.chunks[chunkIndex];
    const chunkFieldOffsets = allComputedOffsets.slice(offsetIndex, offsetIndex + chunk.fields.length);
    const chunkBaseOffset = topLevelOffsets[1].children![chunkIndex].offset;
    const fieldStart =
      chunkIndex === 0 ? 1 : fieldMapping.chunks.slice(0, chunkIndex).reduce((sum, c) => sum + c.fields.length, 0) + 1;
    const fieldEnd = fieldStart + chunk.fields.length - 1;

    console.log(`   Chunk ${chunkIndex + 1} (fields ${fieldStart}-${fieldEnd}):`);
    console.log(`     Types: [${chunkTypes.join(', ')}]`);
    console.log(`     ✅ Using offsets from computeAllOffsets utility (${chunkFieldOffsets.length} field(s))`);

    try {
      const decodedValues = abiDecodeChunk(chunkHex, chunkTypes);
      const chunkData = chunkHex.startsWith('0x') ? chunkHex.slice(2) : chunkHex;
      const chunkBuffer = Buffer.from(chunkData, 'hex');

      console.log(`     Field-by-field verification:\n`);
      for (let fieldIndex = 0; fieldIndex < chunkFieldOffsets.length; fieldIndex++) {
        const fieldOffset = chunkFieldOffsets[fieldIndex];
        const fieldType = chunkTypes[fieldIndex];
        const expectedValue = decodedValues[fieldIndex];

        console.log(`       Field ${fieldIndex + 1} (${chunk.fields[fieldIndex].name}):`);
        console.log(`         Type: ${fieldType}`);
        console.log(`         Absolute offset: ${fieldOffset.offset}`);
        console.log(`         Relative offset in chunk: ${fieldOffset.offset - chunkBaseOffset}`);
        console.log(`         IsDynamic: ${fieldOffset.isDynamic}`);
        console.log(`         Size: ${fieldOffset.size ?? 'undefined (empty array OK)'}`);

        // Verify offset is correct by checking if it matches expected location
        if (!fieldOffset.isDynamic && fieldOffset.size) {
          const relativeOffset = fieldOffset.offset - chunkBaseOffset;
          if (relativeOffset >= 0 && relativeOffset < chunkBuffer.length) {
            const extractedWord = chunkBuffer.slice(relativeOffset, Math.min(relativeOffset + 32, chunkBuffer.length));
            const extractedHex = '0x' + extractedWord.toString('hex');

            try {
              const coder = AbiCoder.defaultAbiCoder();
              const encodedExpected = coder.encode([fieldType], [expectedValue]);
              const matches = extractedHex.toLowerCase() === encodedExpected.toLowerCase();
              console.log(`         ${matches ? '✅' : '❌'} Value match: ${matches}`);
              if (!matches) {
                fieldMismatches++;
                result.errors.push(
                  `Field ${chunk.fields[fieldIndex].name} (chunk ${chunkIndex + 1}, field ${fieldIndex + 1}): Value mismatch`,
                );
                try {
                  const decoded = coder.decode([fieldType], extractedHex);
                  console.log(`         Extracted value: ${decoded[0]}`);
                  console.log(`         Expected value: ${expectedValue}`);
                } catch (e) {
                  console.log(`         Could not decode extracted value`);
                }
              }
            } catch (e) {
              result.warnings.push(
                `Field ${chunk.fields[fieldIndex].name} (chunk ${chunkIndex + 1}, field ${fieldIndex + 1}): Could not verify value`,
              );
              console.log(`         Could not verify value: ${e}`);
            }
          }
        }
        console.log();
      }
    } catch (error: any) {
      result.passed = false;
      result.errors.push(`Chunk ${chunkIndex + 1}: Failed to verify offsets: ${error.message}`);
      console.log(`     ❌ Failed to verify offsets: ${error.message}`);
      console.log(`       Error stack: ${error.stack}`);
    }

    offsetIndex += chunk.fields.length;
    console.log();
  }

  if (fieldMismatches > 0) {
    result.passed = false;
    console.log(`   ❌ Found ${fieldMismatches} field mismatch(es)`);
  } else {
    console.log(`   ✅ All field offsets verified`);
  }

  return result;
}

/**
 * Verifies ERC20 transfer event query offsets
 */
async function verifyERC20EventQuery(ctx: InvestigationContext): Promise<VerificationResult> {
  const result: VerificationResult = {
    name: 'ERC20 Transfer Event Query',
    passed: true,
    errors: [],
    warnings: [],
  };

  console.log('\n=== 5. ERC20 Transfer Event Query Verification ===');

  try {
    const builder = QueryBuilder.createFromTransaction(ctx.tx, ctx.receipt, EncodingVersion.V1);

    builder.setAbiProvider(async (contractAddress: string) => {
      return JSON.stringify(ERC20_ABI);
    });

    builder.addStaticField(QueryableFields.RxStatus);
    builder.addStaticField(QueryableFields.TxChainId);
    await builder.eventBuilder(
      'Transfer',
      () => true,
      (b: QueryBuilderForEvent) =>
        b.addAddress().addSignature().addArgument('from').addArgument('to').addArgument('value'),
    );

    const queryOffsets = builder.build();
    console.log(`   ✅ Created ERC20 transfer query with ${queryOffsets.length} offset(s)`);

    // Debug: Check the log structure
    const logsOffset = builder['mappedOffsets'].get(QueryableFields.RxLogs);
    if (logsOffset && logsOffset.children) {
      console.log(`   Debug: Logs structure:`);
      console.log(
        `     Logs offset: ${logsOffset.offset}, size: ${logsOffset.size}, children: ${logsOffset.children.length}`,
      );

      // Find the Transfer event log
      const transferEvent = ctx.receipt.logs.find((log) => {
        try {
          const iface = new Interface(ERC20_ABI);
          const parsed = iface.parseLog(log);
          return parsed && parsed.name === 'Transfer';
        } catch {
          return false;
        }
      });

      if (transferEvent) {
        const logIndex = ctx.receipt.logs.indexOf(transferEvent);
        const logOffset = logsOffset.children[logIndex];

        if (logOffset) {
          console.log(`     Transfer log index: ${logIndex}`);
          console.log(`     Log offset: ${logOffset.offset}, size: ${logOffset.size}`);
          console.log(`     Log children: ${logOffset.children?.length || 0}`);
          if (logOffset.children) {
            console.log(
              `       [0] address offset: ${logOffset.children[0]?.offset}, size: ${logOffset.children[0]?.size}`,
            );
            console.log(
              `       [1] topics offset: ${logOffset.children[1]?.offset}, size: ${logOffset.children[1]?.size}, children: ${logOffset.children[1]?.children?.length || 0}`,
            );
            if (logOffset.children[1]?.children) {
              console.log(
                `         [0] signature offset: ${logOffset.children[1].children[0]?.offset}, size: ${logOffset.children[1].children[0]?.size}`,
              );
              if (logOffset.children[1].children.length > 1) {
                console.log(
                  `         [1] topic[0] offset: ${logOffset.children[1].children[1]?.offset}, size: ${logOffset.children[1].children[1]?.size}`,
                );
              }
            }
            console.log(
              `       [2] data offset: ${logOffset.children[2]?.offset}, size: ${logOffset.children[2]?.size}`,
            );
          }
        }
      }
      console.log();
    }

    const expectedFields = [
      'receipt.status',
      'tx.chainId',
      'event.tokenAddress',
      'event.signature',
      'event.from',
      'event.to',
      'event.value',
    ];

    // Get expected values from the Transfer event first
    const transferEvent = ctx.receipt.logs.find((log) => {
      try {
        const iface = new Interface(ERC20_ABI);
        const parsed = iface.parseLog(log);
        return parsed && parsed.name === 'Transfer';
      } catch {
        return false;
      }
    });

    if (!transferEvent) {
      result.warnings.push('No Transfer event found in receipt (may not be ERC20 transfer)');
      console.log(`   ⚠️ No Transfer event found in receipt (may not be ERC20 transfer)`);
      return result;
    }

    console.log(`   ✅ Found Transfer event in receipt`);
    try {
      const iface = new Interface(ERC20_ABI);
      const parsed = iface.parseLog(transferEvent);
      if (parsed) {
        const expectedTokenAddress = transferEvent.address.toLowerCase();
        const expectedSignature =
          transferEvent.topics[0]?.toLowerCase() ||
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const expectedFrom = parsed.args[0].toLowerCase();
        const expectedTo = parsed.args[1].toLowerCase();
        const expectedValue = parsed.args[2];

        console.log(`     Expected values:`);
        console.log(`       Token Address: ${expectedTokenAddress}`);
        console.log(`       Signature: ${expectedSignature}`);
        console.log(`       From: ${expectedFrom}`);
        console.log(`       To: ${expectedTo}`);
        console.log(`       Value: ${expectedValue}`);
        console.log();
      }
    } catch (error: any) {
      result.warnings.push(`Could not parse event: ${error.message}`);
      console.log(`     ⚠️ Could not parse event: ${error.message}`);
    }

    // Now verify extracted values match expected values
    console.log(`   Comparing extracted values with expected values:\n`);
    console.log(`   Query offsets computed by QueryBuilder:`);
    queryOffsets.forEach((off, idx) => {
      console.log(`     [${idx}] ${expectedFields[idx] || 'field'}: offset=${off.offset}, size=${off.size}`);
    });
    console.log();

    const iface = new Interface(ERC20_ABI);
    const parsed = iface.parseLog(transferEvent);
    if (!parsed) {
      result.warnings.push('Could not parse Transfer event');
      return result;
    }

    const expectedValues = {
      status: ctx.receipt.status === 1 ? 1 : 0,
      chainId: ctx.tx.chainId || 0n,
      tokenAddress: transferEvent.address.toLowerCase(),
      signature:
        transferEvent.topics[0]?.toLowerCase() || '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      from: parsed.args[0].toLowerCase(),
      to: parsed.args[1].toLowerCase(),
      value: parsed.args[2],
    };

    const coder = AbiCoder.defaultAbiCoder();
    let mismatchCount = 0;

    for (let i = 0; i < queryOffsets.length; i++) {
      const offset = queryOffsets[i];
      const fieldName = expectedFields[i] || `field ${i + 1}`;

      console.log(`     ${fieldName}:`);
      console.log(`       Offset: ${offset.offset}, Size: ${offset.size}`);

      if (offset.offset + offset.size > ctx.dataBuffer.length) {
        result.passed = false;
        result.errors.push(`${fieldName}: Offset out of bounds`);
        console.log(`       ❌ Offset out of bounds`);
        continue;
      }

      const extractedData = ctx.dataBuffer.slice(offset.offset, offset.offset + offset.size);
      const extractedHex = '0x' + extractedData.toString('hex');

      try {
        let matches = false;
        let extracted: any;
        let expected: any;

        if (i === 0) {
          // receipt.status - uint8
          extracted = coder.decode(['uint8'], extractedHex);
          expected = expectedValues.status;
          matches = Number(extracted[0]) === expected;
        } else if (i === 1) {
          // tx.chainId - uint64
          extracted = coder.decode(['uint64'], extractedHex);
          expected = expectedValues.chainId;
          const expectedHex = coder.encode(['uint64'], [expected]).toLowerCase();
          matches = extractedHex.toLowerCase() === expectedHex;
        } else if (i === 2) {
          // tokenAddress - address
          extracted = coder.decode(['address'], extractedHex);
          expected = expectedValues.tokenAddress;
          matches = extracted[0].toLowerCase() === expected;
        } else if (i === 3) {
          // signature - bytes32
          extracted = coder.decode(['bytes32'], extractedHex);
          expected = expectedValues.signature;
          matches = extracted[0].toLowerCase() === expected;
        } else if (i === 4) {
          // from - address
          extracted = coder.decode(['address'], extractedHex);
          expected = expectedValues.from;
          matches = extracted[0].toLowerCase() === expected;
        } else if (i === 5) {
          // to - address
          extracted = coder.decode(['address'], extractedHex);
          expected = expectedValues.to;
          matches = extracted[0].toLowerCase() === expected;
        } else if (i === 6) {
          // value - uint256
          extracted = coder.decode(['uint256'], extractedHex);
          expected = expectedValues.value;
          const expectedHex = coder.encode(['uint256'], [expected]).toLowerCase();
          matches = extractedHex.toLowerCase() === expectedHex;
        }

        console.log(`       Extracted: ${Array.isArray(extracted) ? extracted[0] : extracted}`);
        console.log(`       Expected: ${expected || 'N/A'}`);
        console.log(`       ${matches ? '✅' : '❌'} Match: ${matches}`);

        if (!matches) {
          mismatchCount++;
          result.errors.push(`${fieldName}: Extracted value does not match expected value`);
          if (i === 1 || i === 6) {
            // Show hex comparison for uint64/uint256
            const expectedHex =
              i === 1
                ? coder.encode(['uint64'], [expected]).toLowerCase()
                : coder.encode(['uint256'], [expected]).toLowerCase();
            console.log(`       Extracted hex: ${extractedHex.toLowerCase()}`);
            console.log(`       Expected hex: ${expectedHex}`);
            console.log(`       ❌ Hex mismatch!`);
          } else if (expected) {
            console.log(
              `       ❌ MISMATCH: Expected ${expected}, got ${Array.isArray(extracted) ? extracted[0] : extracted}`,
            );
          }
        }

        // Show full hex for debugging
        console.log(`       Full hex: ${extractedHex}`);
      } catch (error: any) {
        result.errors.push(`${fieldName}: Could not decode: ${error.message}`);
        console.log(`       ⚠️ Could not decode: ${error.message}`);
        console.log(`       Full hex: ${extractedHex}`);
      }
      console.log();
    }

    if (mismatchCount > 0) {
      result.passed = false;
      console.log(`   ❌ Found ${mismatchCount} mismatch(es)`);
    } else {
      console.log(`   ✅ All ERC20 event query fields verified`);
    }
  } catch (error: any) {
    result.passed = false;
    result.errors.push(`Failed to create/verify ERC20 query: ${error.message}`);
    console.log(`   ❌ Failed: ${error.message}`);
  }

  return result;
}

/**
 * Prints verification summary
 */
function printSummary(results: VerificationResult[]): void {
  console.log('\n' + '='.repeat(60));
  console.log('=== VERIFICATION SUMMARY ===');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\nTotal Checks: ${results.length}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ${failed > 0 ? '❌' : ''}`);

  console.log('\n--- Detailed Results ---\n');

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} - ${result.name}`);

    if (result.errors.length > 0) {
      console.log(`  Errors:`);
      result.errors.forEach((err) => console.log(`    - ${err}`));
    }

    if (result.warnings.length > 0) {
      console.log(`  Warnings:`);
      result.warnings.forEach((warn) => console.log(`    - ${warn}`));
    }
  }

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('✅ ALL VERIFICATIONS PASSED');
  } else {
    console.log(`❌ ${failed} VERIFICATION(S) FAILED`);
    process.exit(1);
  }

  console.log('='.repeat(60) + '\n');
}

/**
 * Main investigation function
 */
export async function investigateEncoding() {
  const sourceChainRpc = new JsonRpcProvider(process.env.SOURCE_CHAIN_RPC!);
  const transactionHash =
    process.env.TRANSACTION_HASH || '0x0eebc783f7577b6cf7ef2bf3370127603c85168da9deb41bb8731887cdf48c2e';

  console.log('\n=== Encoding Investigation ===');
  console.log(`Transaction Hash: ${transactionHash}\n`);

  // Fetch transaction and receipt
  console.log('Fetching transaction and receipt...');
  const tx = await sourceChainRpc.getTransaction(transactionHash);
  if (!tx) {
    throw new Error(`Transaction not found: ${transactionHash}`);
  }
  const receipt = await sourceChainRpc.getTransactionReceipt(transactionHash);
  if (!receipt) {
    throw new Error(`Receipt not found: ${transactionHash}`);
  }
  console.log(`✅ Transaction found (Block: ${tx.blockNumber}, Type: ${tx.type})\n`);

  // Encode
  console.log('Encoding transaction and receipt...');
  const encodeResult = abiEncode({ kind: 'ethereum', tx, rx: receipt }, EncodingVersion.V1);
  console.log(`✅ Encoded ${encodeResult.types.length} fields`);
  console.log(`✅ ABI string length: ${encodeResult.abi.length} chars\n`);

  // Decode chunks
  console.log('Decoding chunks...');
  const chunks = abiDecodeChunks(encodeResult.abi);
  console.log(`✅ Decoded ${chunks.length} chunk(s)\n`);

  // Prepare data buffer
  const encodedData = encodeResult.abi.startsWith('0x') ? encodeResult.abi.slice(2) : encodeResult.abi;
  const dataBuffer = Buffer.from(encodedData, 'hex');

  // Create context
  const ctx: InvestigationContext = {
    tx,
    receipt,
    encodeResult,
    chunks,
    dataBuffer,
    verificationResults: [],
  };

  // Run all verifications
  ctx.verificationResults.push(verifyTransactionType(ctx));
  ctx.verificationResults.push(verifyChunkDecoding(ctx));
  ctx.verificationResults.push(verifyChunkIntegrity(ctx));
  ctx.verificationResults.push(verifyFieldOffsets(ctx));
  ctx.verificationResults.push(await verifyERC20EventQuery(ctx));

  // Print summary
  printSummary(ctx.verificationResults);
}

investigateEncoding()
  .then(() => {
    console.log('Investigation complete');
  })
  .catch((error: any) => {
    console.error('Error:', error);
    process.exit(1);
  });
