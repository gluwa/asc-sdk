import { TransactionResponse, TransactionReceipt, AbiCoder, ParamType } from 'ethers';
import { FieldMetadata, QueryableFields } from './models';
import { computeAbiOffsets, WORD_SIZE } from './abi-utils';
import { abiEncode, EncodingVersion } from '../../encoding/abi';
import { getAllFieldsForTransaction } from './encoding-mapping';
import { TransactionWithRaw } from '../../encoding';

/**
 * Recursively makes offsets absolute by adding baseOffset to field and all children
 */
export function makeOffsetsAbsolute(field: FieldMetadata, baseOffset: number): FieldMetadata {
  return {
    ...field,
    offset: field.offset + baseOffset,
    children: field.children?.map((child) => makeOffsetsAbsolute(child, baseOffset)) || [],
  };
}

/**
 * Computes all field offsets for a transaction/receipt encoding
 * This is the same logic used by QueryBuilder.computeAllOffsets()
 *
 * @param tx - Transaction response
 * @param rx - Transaction receipt
 * @param encoding - Encoding version
 * @returns Map of field enums to their offset metadata, and flat array of computed offsets
 */
export function computeAllOffsets(
  tx: TransactionWithRaw,
  rx: TransactionReceipt,
  encoding: EncodingVersion = EncodingVersion.V1,
): { map: Map<QueryableFields, FieldMetadata>; computedOffsets: FieldMetadata[] } {
  const result = abiEncode({ kind: 'ethereum', tx, rx }, encoding);

  // Get explicit chunk definitions
  const fieldMapping = getAllFieldsForTransaction(tx.formatted.type, encoding);
  if (!fieldMapping.chunks) {
    throw new Error('Field mapping must use explicit chunks structure');
  }

  // Step 1: Compute offsets for the (uint8, bytes[]) structure
  // This gives us the byte offset for each chunk element's DATA (after length prefix)
  const paramTypes = [ParamType.from('uint8'), ParamType.from('bytes[]')];
  const offsets = computeAbiOffsets(paramTypes, result.abi);

  // offsets[0] is the uint8 (type) field
  // offsets[1] is the bytes[] array field
  if (!offsets || offsets.length < 2 || !offsets[1].children || offsets[1].children.length === 0) {
    throw new Error('Failed to compute offsets for (uint8, bytes[]) structure');
  }

  // Get the bytes[] array offset
  const bytesArrayOffset = offsets[1];

  // Decode (uint8, bytes[]) to get the actual chunk data (needed for Step 2)
  const coder = AbiCoder.defaultAbiCoder();
  const decoded = coder.decode(['uint8', 'bytes[]'], result.abi);
  const chunks = decoded[1] as string[];

  if (bytesArrayOffset.children.length !== chunks.length) {
    throw new Error(
      `Mismatch: computed ${bytesArrayOffset.children.length} chunk offsets but decoded ${chunks.length} chunks`,
    );
  }

  if (fieldMapping.chunks.length !== chunks.length) {
    throw new Error(
      `Mismatch: field mapping has ${fieldMapping.chunks.length} chunks but encoding produced ${chunks.length} chunks`,
    );
  }

  // Step 2: For each EXPLICIT chunk, compute offsets
  const computedOffsets: FieldMetadata[] = [];

  for (let chunkIndex = 0; chunkIndex < fieldMapping.chunks.length; chunkIndex++) {
    const chunkFields = fieldMapping.chunks[chunkIndex];

    // Get types for this chunk (extract from chunk.fields)
    const chunkTypes = chunkFields.fields.map((f) => f.type);

    // Get the chunk's absolute byte offset from Step 1
    // chunkElementOffset.offset points to where the chunk's DATA starts (after length prefix)
    const chunkElementOffset = bytesArrayOffset.children[chunkIndex];
    if (!chunkElementOffset) {
      throw new Error(`Missing chunk offset for index ${chunkIndex}`);
    }

    // chunkElementOffset.offset is the absolute byte position where chunk's data starts
    // (already past the chunk's length prefix in the bytes[] encoding)
    const chunkDataOffset = chunkElementOffset.offset;

    // Step 3: Compute offsets for fields within this chunk
    // chunk is the decoded bytes value (raw bytes data, no length prefix)
    // When ethers decodes a 'bytes' type, it strips the length prefix
    const chunk = chunks[chunkIndex];
    const chunkParamTypes = chunkTypes.map((type) => ParamType.from(type));
    const chunkFieldOffsets = computeAbiOffsets(chunkParamTypes, chunk);

    // Step 4: Combine offsets to get absolute positions
    // chunkFieldOffsets[].offset are relative to chunk's data start (no length prefix)
    // chunkDataOffset is the absolute position where chunk's data starts (after chunk's length prefix)
    // We recursively update all offsets (including nested children) to be absolute
    for (const fieldOffset of chunkFieldOffsets) {
      // Recursively make all offsets absolute, including nested children
      // This is critical for dynamic structures like tuple(address, bytes32[], bytes)[]
      // where children offsets must also be absolute for QueryBuilderForEvent to work correctly
      const absoluteField = makeOffsetsAbsolute(fieldOffset, chunkDataOffset);
      computedOffsets.push(absoluteField);
    }
  }

  // Step 5: Build flat field list for mapping (from chunks)
  const allFields: Array<{ name: QueryableFields; type: string }> = [];
  for (const chunk of fieldMapping.chunks) {
    allFields.push(...chunk.fields);
  }

  if (computedOffsets.length != allFields.length)
    throw new Error('the number of fields of computed offsets should match the number of fields of the transaction..');

  const map = new Map<QueryableFields, FieldMetadata>();
  // Handle type_ separately since it's encoded as the first uint8 parameter (not in chunks)
  map.set(QueryableFields.Type, {
    type: 'uint8',
    offset: WORD_SIZE, // First 32 bytes after bytes memory length prefix
    isDynamic: false,
    size: 1,
    children: [],
    value: tx.formatted.type,
  });

  allFields.forEach((field, index) => {
    let computedOffset = computedOffsets[index];
    const fieldType = ParamType.from(field.type);
    const computedOffsetType = ParamType.from(computedOffset.type);
    if (fieldType.type != computedOffsetType.type) {
      throw new Error(
        `Types of computed offset should match field type.. ${fieldType.type} != ${computedOffsetType.type}`,
      );
    }

    map.set(field.name, computedOffsets[index]);
  });

  return { map, computedOffsets };
}
