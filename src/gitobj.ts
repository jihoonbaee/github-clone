// Git object model: hashing, commit/tree/tag parse and build, and packfiles
// (read with full OFS_DELTA / REF_DELTA resolution, write as whole objects).
// Pure stdlib: node:crypto for SHA-1, node:zlib for pack compression.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of `type` + `data`, as git computes it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Parse a commit object into its fields. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. `author`/`committer` are full identity lines (`Name <email> ts +0000`). */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  lines.push('', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a tree object into its entries (modes kept verbatim, e.g. `40000` for dirs). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: truncated entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, sorted the way git sorts them (dirs as `name/`). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return Buffer.compare(Buffer.from(aKey, 'utf8'), Buffer.from(bKey, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

/** Write a version-2 packfile of whole objects (no deltas). Order is the caller's. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    const size = object.data.length;
    const head: number[] = [];
    let remaining = size;
    head.push((code << 4) | (remaining & 0x0f));
    remaining >>>= 4;
    while (remaining > 0) {
      head[head.length - 1]! |= 0x80;
      head.push(remaining & 0x7f);
      remaining >>>= 7;
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

/** Apply a git delta to its base, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('malformed delta: truncated varint');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('malformed delta: base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('malformed delta: truncated copy offset');
          copyOffset |= delta[offset]! << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('malformed delta: truncated copy size');
          copySize |= delta[offset]! << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('malformed delta: copy past base end');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('malformed delta: truncated insert');
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('malformed delta: zero opcode');
    }
  }
  if (produced !== targetSize) throw new Error('malformed delta: target size mismatch');
  return Buffer.concat(chunks);
}

/**
 * Parse a version-2 packfile, resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` looks a REF_DELTA base up outside the pack (the repo's object store).
 * Throws on a bad signature, a bad trailer checksum, or an unresolvable delta.
 */
export function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 32) throw new Error('malformed pack: too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('malformed pack: bad signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`malformed pack: unsupported version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('malformed pack: trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= pack.length - 20) throw new Error('malformed pack: truncated object header');
    let byte = pack[offset]!;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= pack.length - 20) throw new Error('malformed pack: truncated size');
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: PackEntry | GitObject | undefined;
    if (code === 6) {
      // OFS_DELTA: the base is an earlier object in this pack, by negative offset.
      if (offset >= pack.length - 20) throw new Error('malformed pack: truncated ofs-delta offset');
      byte = pack[offset]!;
      offset += 1;
      let distance = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= pack.length - 20) throw new Error('malformed pack: truncated ofs-delta offset');
        byte = pack[offset]!;
        offset += 1;
        distance = ((distance + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(entryOffset - distance);
      if (base === undefined) throw new Error('malformed pack: ofs-delta base not in pack');
    } else if (code === 7) {
      // REF_DELTA: the base is named by oid; it may live in the pack or in the store.
      if (offset + 20 > pack.length - 20) throw new Error('malformed pack: truncated ref-delta base');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = byOid.get(baseOid) ?? resolveBase(baseOid);
      if (base === undefined) throw new Error(`malformed pack: ref-delta base ${baseOid} not found`);
    } else if (CODE_TYPE[code] === undefined) {
      throw new Error(`malformed pack: unknown object type code ${code}`);
    }
    // Inflate one zlib stream starting at `offset`; inflateSync with { info: true }
    // reports how many input bytes the stream consumed, so the next object starts there.
    // The header size is the INFLATED DATA's size for every entry type: for a
    // delta entry that is the delta instructions' size, NOT the reconstructed
    // object's (the delta's own target-size varint, checked inside applyDelta,
    // governs the reconstruction).
    const inflated = inflateOne(pack, offset, pack.length - 20);
    offset = inflated.endOffset;
    if (inflated.data.length !== size) throw new Error('malformed pack: object size mismatch');
    let entry: PackEntry;
    if (code === 6 || code === 7) {
      if (base === undefined) throw new Error('malformed pack: delta without a base');
      const data = applyDelta(base.data, inflated.data);
      entry = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      const type = CODE_TYPE[code]!;
      entry = { oid: hashObject(type, inflated.data), type, data: inflated.data };
    }
    entries.push(entry);
    byOffset.set(entryOffset, entry);
    byOid.set(entry.oid, entry);
  }
  return entries;
}

/** Inflate exactly one zlib stream starting at `start` (before `limit`), reporting its end. */
function inflateOne(pack: Buffer, start: number, limit: number): { data: Buffer; endOffset: number } {
  try {
    const result = inflateSync(pack.subarray(start, limit), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    return { data: result.buffer, endOffset: start + result.engine.bytesWritten };
  } catch {
    throw new Error('malformed pack: object does not inflate');
  }
}
