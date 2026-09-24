import { createHash } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const IPFS_CHUNK_SIZE = 256 * 1024;
const IPFS_MAX_LINKS = 174;
const HASH_KEYS = { ipfs: 34, bzzr0: 32, bzzr1: 32 };

function hexToBytes(hex) {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(body, 'hex');
}

function bytesToHex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function varint(value) {
  const out = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Buffer.from(out);
}

function lengthDelimited(tag, bytes) {
  return Buffer.concat([Buffer.from([tag]), varint(bytes.length), bytes]);
}

function multihash(block) {
  return Buffer.concat([Buffer.from([0x12, 0x20]), createHash('sha256').update(block).digest()]);
}

function combineLinks(links) {
  const data = [];
  const lengths = [];
  let size = 0;
  let blockSize = 0;
  for (const link of links) {
    size += link.size;
    blockSize += link.blockSize;
    const pbLink = Buffer.concat([lengthDelimited(0x0a, link.hash), Buffer.from([0x12, 0x00, 0x18]), varint(link.blockSize)]);
    data.push(lengthDelimited(0x12, pbLink));
    lengths.push(Buffer.concat([Buffer.from([0x20]), varint(link.size)]));
  }
  const unixfs = Buffer.concat([Buffer.from([0x08, 0x02, 0x18]), varint(size), ...lengths]);
  const block = Buffer.concat([...data, lengthDelimited(0x0a, unixfs)]);
  return { hash: multihash(block), size, blockSize: blockSize + block.length };
}

/**
 * Returns the IPFS CIDv0 multihash (`0x1220...`) that solc embeds for the metadata string.
 * The chunk and link layout follows solc's `libsolutil/IpfsHash.cpp`.
 */
export function ipfsMetadataHash(text) {
  const data = Buffer.from(text, 'utf8');
  const count = Math.max(1, Math.ceil(data.length / IPFS_CHUNK_SIZE));
  let level = [];
  for (let index = 0; index < count; index++) {
    const chunk = data.subarray(index * IPFS_CHUNK_SIZE, (index + 1) * IPFS_CHUNK_SIZE);
    const parts = [Buffer.from([0x08, 0x02])];
    if (chunk.length > 0) parts.push(lengthDelimited(0x12, chunk));
    parts.push(Buffer.from([0x18]), varint(chunk.length));
    const block = lengthDelimited(0x0a, Buffer.concat(parts));
    level.push({ hash: multihash(block), size: chunk.length, blockSize: block.length });
  }
  while (level.length > 1) {
    const next = [];
    for (let start = 0; start < level.length; start += IPFS_MAX_LINKS) next.push(combineLinks(level.slice(start, start + IPFS_MAX_LINKS)));
    level = next;
  }
  return bytesToHex(level[0].hash);
}

/** Encodes a `0x1220...` multihash as a base58 CIDv0 string (`Qm...`). */
export function cidV0(multihashHex) {
  const bytes = hexToBytes(multihashHex);
  let number = BigInt(bytesToHex(bytes));
  let out = '';
  while (number > 0n) {
    out = BASE58[Number(number % 58n)] + out;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function decodeItem(bytes, offset) {
  if (offset >= bytes.length) throw new Error('CBOR ends early.');
  const initial = bytes[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = offset + 1;
  let argument;
  if (info < 24) argument = info;
  else if (info === 24) argument = bytes[cursor++];
  else if (info === 25) {
    argument = (bytes[cursor] << 8) | bytes[cursor + 1];
    cursor += 2;
  } else if (info === 26) {
    argument = bytes.readUInt32BE(cursor);
    cursor += 4;
  } else throw new Error('CBOR item is not supported.');
  if (argument === undefined || cursor > bytes.length) throw new Error('CBOR ends early.');

  if (major === 0) return { value: argument, next: cursor };
  if (major === 2 || major === 3) {
    const end = cursor + argument;
    if (end > bytes.length) throw new Error('CBOR string ends early.');
    const slice = bytes.subarray(cursor, end);
    return { value: major === 2 ? bytesToHex(slice) : slice.toString('utf8'), next: end };
  }
  if (major === 5) {
    const value = {};
    let next = cursor;
    for (let index = 0; index < argument; index++) {
      const key = decodeItem(bytes, next);
      if (typeof key.value !== 'string') throw new Error('CBOR map key is not text.');
      const item = decodeItem(bytes, key.next);
      value[key.value] = item.value;
      next = item.next;
    }
    return { value, next };
  }
  if (major === 7 && info === 20) return { value: false, next: cursor };
  if (major === 7 && info === 21) return { value: true, next: cursor };
  throw new Error('CBOR item is not supported.');
}

/**
 * Reads the solc CBOR metadata tail of runtime or creation code.
 * Returns `null` when the code has no valid tail. The result records the byte offset where the tail starts.
 */
export function decodeMetadataTail(code) {
  const text = code.startsWith('0x') ? code.slice(2) : code;
  if (text.length < 4 || text.length % 2 !== 0 || !/^[0-9a-fA-F]{4}$/.test(text.slice(-4))) return null;
  const length = parseInt(text.slice(-4), 16);
  const start = text.length / 2 - 2 - length;
  if (length === 0 || start < 0) return null;
  const tailHex = text.slice(start * 2);
  if (!/^[0-9a-fA-F]*$/.test(tailHex)) return null;
  const tailBytes = hexToBytes(tailHex);
  let decoded;
  try {
    decoded = decodeItem(tailBytes.subarray(0, length), 0);
  } catch {
    return null;
  }
  if (decoded.next !== length || !decoded.value || typeof decoded.value !== 'object' || Array.isArray(decoded.value)) return null;
  const map = decoded.value;
  const tail = { start, raw: `0x${tailHex.toLowerCase()}`, map };
  for (const [kind, size] of Object.entries(HASH_KEYS)) {
    if (typeof map[kind] === 'string' && (map[kind].length - 2) / 2 === size) {
      tail.hashKind = kind;
      tail.hash = map[kind];
      break;
    }
  }
  if (typeof map.solc === 'string' && map.solc.length === 8) {
    const release = hexToBytes(map.solc);
    tail.solc = `${release[0]}.${release[1]}.${release[2]}`;
  } else if (typeof map.solc === 'string' && !map.solc.startsWith('0x')) {
    tail.solc = map.solc;
  }
  return tail;
}
