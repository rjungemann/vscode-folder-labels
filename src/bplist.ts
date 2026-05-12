/**
 * Minimal binary plist (bplist00) parser and builder.
 *
 * Only handles the subset of the format used by com.apple.metadata:_kMDItemUserTags:
 * a top-level array of ASCII or UTF-16 strings. All other plist object types are
 * unsupported and will cause parsing to return `undefined`.
 *
 * No external dependencies — pure TypeScript/Node.js Buffer operations.
 */

const MAGIC = Buffer.from('bplist00', 'ascii');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read an unsigned integer of `size` bytes (big-endian) from `buf` at `offset`. */
function readUIntN(buf: Buffer, offset: number, size: number): number {
  let val = 0;
  for (let i = 0; i < size; i++) {
    val = (val * 256 + buf[offset + i]) >>> 0;
  }
  return val;
}

/**
 * Read an inline integer object starting at `offset`.
 * Returns [value, totalBytesConsumed].
 */
function readIntObject(buf: Buffer, offset: number): [number, number] {
  const marker = buf[offset];
  if ((marker >> 4) !== 0x1) {
    throw new Error(`Expected int object at offset ${offset}, got 0x${marker.toString(16)}`);
  }
  const byteSize = 1 << (marker & 0xF);
  return [readUIntN(buf, offset + 1, byteSize), 1 + byteSize];
}

type PlistValue = string | PlistValue[];

function parseObjectAt(
  buf: Buffer,
  offset: number,
  refSize: number,
  offsets: readonly number[],
): PlistValue {
  const marker = buf[offset];
  const high = (marker >> 4) & 0xF;
  const low  = marker & 0xF;

  // ASCII string (type 0x5)
  if (high === 0x5) {
    let len: number;
    let dataOff: number;
    if (low === 0xF) {
      const [v, consumed] = readIntObject(buf, offset + 1);
      len = v; dataOff = offset + 1 + consumed;
    } else {
      len = low; dataOff = offset + 1;
    }
    return buf.subarray(dataOff, dataOff + len).toString('ascii');
  }

  // Unicode string (type 0x6, UTF-16BE)
  if (high === 0x6) {
    let len: number;
    let dataOff: number;
    if (low === 0xF) {
      const [v, consumed] = readIntObject(buf, offset + 1);
      len = v; dataOff = offset + 1 + consumed;
    } else {
      len = low; dataOff = offset + 1;
    }
    // Swap byte pairs (BE → LE) so Node's 'utf16le' codec works.
    const raw = buf.subarray(dataOff, dataOff + len * 2);
    const swapped = Buffer.allocUnsafe(raw.length);
    for (let i = 0; i < raw.length - 1; i += 2) {
      swapped[i]     = raw[i + 1];
      swapped[i + 1] = raw[i];
    }
    return swapped.toString('utf16le');
  }

  // Array (type 0xA)
  if (high === 0xA) {
    let count: number;
    let refsOff: number;
    if (low === 0xF) {
      const [v, consumed] = readIntObject(buf, offset + 1);
      count = v; refsOff = offset + 1 + consumed;
    } else {
      count = low; refsOff = offset + 1;
    }
    const items: PlistValue[] = [];
    for (let i = 0; i < count; i++) {
      const ref = readUIntN(buf, refsOff + i * refSize, refSize);
      items.push(parseObjectAt(buf, offsets[ref], refSize, offsets));
    }
    return items;
  }

  throw new Error(`Unsupported bplist object type 0x${high.toString(16)} at offset ${offset}`);
}

/**
 * Parse a bplist00 buffer whose root object is an array of strings.
 * Returns the string array, or `undefined` if:
 *  - the buffer is not a valid bplist00,
 *  - the root is not an array, or
 *  - any error occurs during parsing.
 *
 * Handles both:
 *  - Standard bplists with offset table and 32-byte trailer
 *  - Minimal bplists written by Finder (inline objects only, no offset table)
 */
export function parseStringArray(buf: Buffer): string[] | undefined {
  try {
    if (buf.length < 8) { return undefined; }
    if (!buf.subarray(0, 8).equals(MAGIC)) { return undefined; }

    // Try standard format first (with offset table + trailer)
    if (buf.length >= 40) {
      const result = parseStringArrayStandard(buf);
      if (result !== undefined) { return result; }
    }

    // Fall back to minimal format (inline objects only, no offset table)
    return parseStringArrayMinimal(buf);
  } catch {
    return undefined;
  }
}

/**
 * Parse a standard bplist with offset table and 32-byte trailer.
 */
function parseStringArrayStandard(buf: Buffer): string[] | undefined {
  try {
    const tBase = buf.length - 32;
    const offsetIntSize     = buf[tBase + 6];
    const objectRefSize     = buf[tBase + 7];
    const numObjects        = Number(buf.readBigUInt64BE(tBase + 8));
    const topObject         = Number(buf.readBigUInt64BE(tBase + 16));
    const offsetTableOffset = Number(buf.readBigUInt64BE(tBase + 24));

    if (offsetIntSize === 0 || objectRefSize === 0 || numObjects === 0) { return undefined; }

    const offsets: number[] = [];
    for (let i = 0; i < numObjects; i++) {
      offsets.push(readUIntN(buf, offsetTableOffset + i * offsetIntSize, offsetIntSize));
    }

    const root = parseObjectAt(buf, offsets[topObject], objectRefSize, offsets);
    if (!Array.isArray(root)) { return undefined; }
    return root.filter((x): x is string => typeof x === 'string');
  } catch {
    return undefined;
  }
}

/**
 * Parse a minimal bplist with inline objects and inline references.
 * This is what Finder writes: magic + objects with embedded references.
 * Layout: "bplist00" + array object (refs inline) + actual objects
 */
function parseStringArrayMinimal(buf: Buffer): string[] | undefined {
  try {
    console.debug(`[Folder Labels] parseStringArrayMinimal: buf len=${buf.length}, hex after magic:`, buf.subarray(8, Math.min(20, buf.length)).toString('hex'));
    
    // Minimal format: parse at offset 8 (after magic)
    // Assume refSize=1 (single-byte object indices)
    const result = parseObjectAtMinimalWithRefs(buf, 8, 1);
    console.debug(`[Folder Labels] parseStringArrayMinimal: parseObjectAtMinimalWithRefs returned:`, result);
    
    if (!Array.isArray(result[0])) { 
      console.debug(`[Folder Labels] parseStringArrayMinimal: root is not array, it's:`, typeof result[0]);
      return undefined; 
    }
    const arr = (result[0] as PlistValue[]).filter((x): x is string => typeof x === 'string');
    console.debug(`[Folder Labels] parseStringArrayMinimal: extracted strings:`, arr);
    return arr;
  } catch (err) {
    console.debug(`[Folder Labels] parseStringArrayMinimal exception:`, err);
    return undefined;
  }
}

/**
 * Parse a bplist object in minimal format with references.
 * Returns [value, bytesConsumed].
 */
function parseObjectAtMinimalWithRefs(buf: Buffer, offset: number, refSize: number): [PlistValue, number] {
  const marker = buf[offset];
  const high = (marker >> 4) & 0xF;
  const low  = marker & 0xF;
  console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs at offset ${offset}: marker=0x${marker.toString(16)} (high=0x${high.toString(16)}, low=0x${low.toString(16)})`);

  // ASCII string (type 0x5)
  if (high === 0x5) {
    let len: number;
    let consumed: number;
    if (low === 0xF) {
      const [v, c] = readIntObject(buf, offset + 1);
      len = v; consumed = 1 + c;
    } else {
      len = low; consumed = 1;
    }
    const str = buf.subarray(offset + consumed, offset + consumed + len).toString('ascii');
    console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs: parsed ASCII string: "${str}"`);
    return [str, consumed + len];
  }

  // Array (type 0xA) with inline references
  if (high === 0xA) {
    let count: number;
    let consumed: number;
    if (low === 0xF) {
      const [v, c] = readIntObject(buf, offset + 1);
      count = v; consumed = 1 + c;
    } else {
      count = low; consumed = 1;
    }
    console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs: array with ${count} elements, refSize=${refSize}`);
    
    // Read references
    const refs: number[] = [];
    for (let i = 0; i < count; i++) {
      refs.push(readUIntN(buf, offset + consumed + i * refSize, refSize));
    }
    consumed += count * refSize;
    console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs: array refs:`, refs);
    
    // Objects follow immediately after refs, parse them in sequence
    const objects: PlistValue[] = [];
    let pos = offset + consumed;
    const firstObjectIndex = 1; // In minimal format: object 0 is the array, object 1+ are the data objects
    for (let i = 0; i < count; i++) {
      console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs: parsing object ${firstObjectIndex + i} at offset ${pos}`);
      const [obj, objConsumed] = parseObjectAtMinimalWithRefs(buf, pos, refSize);
      objects.push(obj);
      pos += objConsumed;
    }
    
    // Return objects in the order referenced by the array
    // Map global object indices (refs) to local array indices (subtracting firstObjectIndex)
    const result: PlistValue[] = [];
    for (const ref of refs) {
      const localIdx = ref - firstObjectIndex;
      if (localIdx >= 0 && localIdx < objects.length) {
        result.push(objects[localIdx]);
      }
    }
    console.debug(`[Folder Labels] parseObjectAtMinimalWithRefs: array complete, consumed ${pos - offset} bytes total, result:`, result);
    return [result, pos - offset];
  }

  throw new Error(`Unsupported bplist object type 0x${high.toString(16)} at offset ${offset}`);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write an unsigned integer of `size` bytes (big-endian) into `buf` at `offset`. */
function writeUIntN(buf: Buffer, offset: number, val: number, size: number): void {
  for (let i = size - 1; i >= 0; i--) {
    buf[offset + i] = val & 0xFF;
    val = Math.floor(val / 256);
  }
}

/** Encode an integer as a bplist int object. */
function buildIntObject(val: number): Buffer {
  if (val < 0x100) {
    return Buffer.from([0x10, val]);
  }
  if (val < 0x10000) {
    const b = Buffer.allocUnsafe(3);
    b[0] = 0x11;
    b.writeUInt16BE(val, 1);
    return b;
  }
  const b = Buffer.allocUnsafe(5);
  b[0] = 0x12;
  b.writeUInt32BE(val, 1);
  return b;
}

/** Encode an ASCII string as a bplist string object. */
function buildStringObject(s: string): Buffer {
  const strBuf = Buffer.from(s, 'ascii');
  const len = strBuf.length;
  if (len < 15) {
    return Buffer.concat([Buffer.from([0x50 | len]), strBuf]);
  }
  return Buffer.concat([Buffer.from([0x5F]), buildIntObject(len), strBuf]);
}

/**
 * Build a bplist00 buffer containing an array of ASCII strings.
 *
 * Layout:
 *   "bplist00"
 *   Object 0  — Array referencing objects 1..n
 *   Object 1  — strings[0]
 *   ...
 *   Object n  — strings[n-1]
 *   Offset table (one entry per object)
 *   Trailer (32 bytes)
 */
export function buildStringArray(strings: string[]): Buffer {
  const n = strings.length;
  // 1 byte per object ref is enough for < 255 objects (more than enough for tags).
  const refSize = n < 255 ? 1 : 2;

  const parts: Buffer[] = [];
  const objectOffsets: number[] = [];
  let pos = 8; // after "bplist00"

  // --- Object 0: Array ---
  objectOffsets.push(pos);
  {
    const refs = Buffer.allocUnsafe(n * refSize);
    for (let i = 0; i < n; i++) {
      writeUIntN(refs, i * refSize, i + 1, refSize); // string objects are at indices 1..n
    }
    const header =
      n < 15
        ? Buffer.from([0xA0 | n])
        : Buffer.concat([Buffer.from([0xAF]), buildIntObject(n)]);
    const arrayBuf = Buffer.concat([header, refs]);
    parts.push(arrayBuf);
    pos += arrayBuf.length;
  }

  // --- Objects 1..n: Strings ---
  for (const s of strings) {
    objectOffsets.push(pos);
    const strBuf = buildStringObject(s);
    parts.push(strBuf);
    pos += strBuf.length;
  }

  // --- Offset table ---
  const offsetTablePos = pos;
  const numObjects = n + 1; // array object + n string objects
  const offsetIntSize = pos < 256 ? 1 : pos < 65536 ? 2 : 4;
  const offsetTable = Buffer.allocUnsafe(numObjects * offsetIntSize);
  for (let i = 0; i < numObjects; i++) {
    writeUIntN(offsetTable, i * offsetIntSize, objectOffsets[i], offsetIntSize);
  }

  // --- Trailer (32 bytes) ---
  const trailer = Buffer.alloc(32, 0);
  // Bytes 0-5: reserved (already zero).
  trailer[6] = offsetIntSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(numObjects), 8);
  trailer.writeBigUInt64BE(BigInt(0), 16);              // topObject = 0 (the array)
  trailer.writeBigUInt64BE(BigInt(offsetTablePos), 24);

  const result = Buffer.concat([MAGIC, ...parts, offsetTable, trailer]);
  console.debug(`[Folder Labels] buildStringArray: strings=${JSON.stringify(strings)}, buffer size=${result.length}, hex=${result.toString('hex').slice(0, 80)}`);
  return result;
}
