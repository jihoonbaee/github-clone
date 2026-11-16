// Smart HTTP: info/refs advertisements (upload-pack v0+v2, receive-pack v0),
// upload-pack (v2 commands ls-refs/fetch, v0 want/have), and receive-pack v0.
// No git binary anywhere: pkt-lines, sideband framing and packfiles are built
// and parsed here, on top of the store.

import { parseCommit, parseTag, parseTree, readPack, writePack, type GitObject } from './gitobj.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { ZERO_OID } from './util.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line framing `text` (which must already end in `\n` when it is a line). */
export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const length = body.length + 4;
  if (length > 65_520) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** A flush packet. */
export function flushPkt(): Buffer {
  return FLUSH;
}

/** A delim packet. */
export function delimPkt(): Buffer {
  return DELIM;
}

export interface ParsedPkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse pkt-lines from the start of `buffer`. Stops at the first malformed packet. */
export function parsePktLines(buffer: Buffer): { packets: ParsedPkt[]; consumed: number } {
  const packets: ParsedPkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (lengthText === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lengthText === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = parseInt(lengthText, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Frame `data` as sideband packets on `band` (1 = data, 2 = progress, 3 = error). */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32_768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    const length = payload.length + 4;
    packets.push(
      Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]),
    );
  }
  return packets;
}

// ---------------------------------------------------------------- ref listing

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs, sorted, with peeled targets for annotated tags. HEAD is not included. */
function listRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const ref: RefLine = { name, oid };
    const object = repo.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      ref.peeled = repo.peel(oid);
    }
    refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_V0_CAPS =
  'multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative filter no-progress include-tag symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** The v0 upload-pack advertisement (also the shape git itself expects). */
function advertiseV0Upload(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), flushPkt()];
  const refs = listRefs(repo);
  const headOid = repo.headOid();
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  } else {
    const first = headOid ?? ZERO_OID;
    parts.push(pktLine(`${first} HEAD\0${UPLOAD_V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** The v0 receive-pack advertisement. */
function advertiseV0Receive(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), flushPkt()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const caps = first ? `\0${RECEIVE_V0_CAPS}` : '';
      first = false;
      parts.push(pktLine(`${ref.oid} ${ref.name}${caps}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** The protocol-v2 upload-pack advertisement. */
function advertiseV2(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    flushPkt(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Decide what a fetch sends. `wants` are the tips the client asked for, `haves`
 * are commits it already holds, `depth` (null = full) caps commit depth, and
 * `clientShallow` are the client's existing shallow boundaries (for unshallow).
 *
 * Included commits: BFS from the wants, depth-limited when asked. A commit is
 * a new shallow boundary when at least one of its parents was NOT included in
 * this fetch. A client boundary that is now fully included is unshallowed.
 * Trees and blobs of included commits are always sent whole.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
  deepenRelative = false,
): FetchPlan {
  const haveSet = repo.collectHaveSet(haves, clientShallow);
  // `deepen-relative` (real git's --deepen): the depth extends each of the
  // client's existing shallow boundaries by `depth` commits, rather than
  // measuring from the wants. A boundary at distance d from a want moves the
  // effective absolute depth to d + depth + 1 (verified against git 2.43's
  // daemon: boundary at distance 1 + deepen 1 yields the parent as the new
  // boundary). Without a reachable boundary, fall back to the absolute depth.
  let effectiveDepth = depth;
  if (deepenRelative && depth !== null && clientShallow.length > 0) {
    let deepest = depth;
    for (const want of wants) {
      const distances = repo.commitDistances(want);
      for (const boundary of clientShallow) {
        const d = distances.get(boundary);
        if (d !== undefined) deepest = Math.max(deepest, d + depth + 1);
      }
    }
    effectiveDepth = deepest;
  }
  // BFS over commits from the wants, tracking distance.
  const includedCommits = new Map<string, number>(); // oid -> distance
  const queue: Array<{ oid: string; distance: number }> = [];
  const tagObjects = new Set<string>();
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const target = repo.peel(want);
      const targetObject = repo.getObject(target);
      if (targetObject?.type === 'commit') queue.push({ oid: target, distance: 0 });
      else if (targetObject !== undefined) tagObjects.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
    } else {
      // A blob/tree want: send it and its closure directly.
      tagObjects.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (includedCommits.has(oid)) continue;
    if (effectiveDepth !== null && distance >= effectiveDepth) continue;
    includedCommits.set(oid, distance);
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!includedCommits.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  // Shallow boundaries: included commits with a parent that was not included.
  const shallow: string[] = [];
  for (const oid of includedCommits.keys()) {
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) {
      shallow.push(oid);
    }
  }
  const shallowSet = new Set(shallow);
  const unshallow = clientShallow.filter((oid) => includedCommits.has(oid) && !shallowSet.has(oid));
  // Objects to send: the included commits + their tree closures + wanted tags,
  // minus anything the client already has. The closure follows commit -> tree
  // and tree -> entries only: it must NOT follow commit parents, or a shallow
  // fetch would carry the history the depth was meant to cut off.
  const send = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (send.has(oid)) continue;
      const object = repo.getObject(oid);
      if (object === undefined) continue;
      send.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  };
  for (const oid of includedCommits.keys()) {
    send.add(oid);
    const treeOid = repo.treeOf(oid);
    if (treeOid !== null) addTreeClosure(treeOid);
  }
  for (const oid of tagObjects) {
    const object = repo.getObject(oid);
    if (object === undefined) continue;
    send.add(oid);
    if (object.type === 'tree') addTreeClosure(oid);
    else if (object.type === 'tag') {
      // A tag's target: a commit is already covered by the BFS above; a tree
      // or blob needs its closure here (a nested tag is followed, bounded).
      let target = parseTag(object.data).object;
      for (let depth = 0; depth < 16; depth += 1) {
        const targetObject = repo.getObject(target);
        if (targetObject === undefined) break;
        if (targetObject.type === 'tag') {
          send.add(target);
          target = parseTag(targetObject.data).object;
          continue;
        }
        if (targetObject.type === 'tree') addTreeClosure(target);
        else if (targetObject.type === 'blob') send.add(target);
        break;
      }
    }
  }
  for (const oid of haveSet) send.delete(oid);
  // The client's shallow boundaries it already has must not be re-sent either
  // (they are in haveSet's closure only when reachable from a have; be explicit).
  for (const oid of clientShallow) {
    if (haveSet.has(oid)) send.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------- upload-pack v2

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = listRefs(repo);
  const headOid = repo.headOid();
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    if (headOid !== null) {
      lines.push(args.symrefs ? `${headOid} HEAD symref-target:${repo.headRef}\n` : `${headOid} HEAD\n`);
    } else if (args.unborn) {
      lines.push(
        args.symrefs ? `unborn HEAD symref-target:${repo.headRef}\n` : `unborn HEAD\n`,
      );
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (text === 'deepen-relative') args.deepenRelative = true;
    else if (text === 'done') {
      // end of the have list; nothing to do
    }
    // thin-pack, no-progress, ofs-delta, filter, agent, object-format: accepted, ignored
  }
  return args;
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.shallow, args.deepenRelative);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent `have` lines
  // to acknowledge: a client with no haves (a fresh clone) skips straight to
  // the packfile, and sending the section breaks real git. With haves, the
  // section ACKs every have that is an ancestor of a want (NAK when none is),
  // and ALWAYS ends with `ready`: over stateless HTTP the client already sent
  // `done`, so negotiation is over and the packfile follows in this response.
  // A NAK without `ready` tells the client to send another round of haves,
  // and a packfile after it is a protocol error.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let common = 0;
    for (const have of args.haves) {
      const isCommon = args.wants.some((want) => repo.isAncestor(have, want));
      if (isCommon) {
        parts.push(pktLine(`ACK ${have}\n`));
        common += 1;
      }
    }
    if (common === 0) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(delimPkt());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(delimPkt());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sideband(1, pack)) parts.push(packet);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const text = packet.payload.toString('utf8').trim();
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      // agent= / object-format= lines are accepted and ignored
    } else {
      lines.push(text);
    }
  }
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      // ref-pattern / ref-prefix patterns beyond prefix: accepted, ignored
    }
    return { status: 200, body: handleLsRefs(repo, args) };
  }
  if (command === 'fetch') {
    return { status: 200, body: handleFetchV2(repo, parseFetchArgs(lines)) };
  }
  return { status: 400, body: Buffer.from('unknown command\n', 'utf8') };
}

// ---------------------------------------------------------------- upload-pack v0

function handleUploadPackV0(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { packets } = parsePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  let done = false;
  for (const packet of packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim') continue;
    // The first want line carries the client's capabilities: after a NUL in
    // real git, after a space in the suite's v0 client. The oid is the first
    // token either way.
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const text = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
    if (text.startsWith('want ')) {
      const oid = text.slice(5).trim().split(/\s+/)[0];
      if (oid !== undefined && oid !== '') args.wants.push(oid);
      // In v0 `deepen-relative` rides as a capability on the want line: after
      // the NUL in real git, after a space in the suite's client — so test the
      // raw line, not the NUL-stripped text.
      if (/\bdeepen-relative\b/.test(raw)) args.deepenRelative = true;
    } else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text === 'done') done = true;
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.shallow, args.deepenRelative);
  // Stateless v0 shallow flow (verified against git 2.43's behaviour): the
  // client reads the shallow list FIRST, then replays the whole request with
  // `done` appended and reads the full response (shallow list again, then
  // ACK/NAK, then the pack). A request without `done` that yields shallow
  // lines must answer with the shallow list ALONE — sending the ACK and the
  // pack already in this response makes the client die with
  // "expected shallow list" when it reads the replay's response.
  if (!done && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    const shallowOnly: Buffer[] = [];
    for (const oid of plan.shallow) shallowOnly.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowOnly.push(pktLine(`unshallow ${oid}\n`));
    shallowOnly.push(flushPkt());
    return { status: 200, body: Buffer.concat(shallowOnly) };
  }
  const pack = writePack(plan.objects);
  // Response order in v0 (pack-protocol.txt; real git errors
  // "expected shallow/unshallow, got NAK" if this is reversed): shallow /
  // unshallow lines FIRST, then the ACK/NAK negotiation, then the packfile.
  // Negotiation, exactly as real git's upload-pack answers it (verified
  // against git 2.43's daemon): one `ACK <oid> common` per have that is an
  // ancestor of a want, then a final PLAIN `ACK <oid>` (no status word) for
  // the last common have — that bare ACK is what ends the ACK phase and tells
  // the client the pack follows. A `ready` status does NOT end the phase in
  // v0 (git keeps reading ACKs and chokes on the pack); NAK covers the
  // no-common-base and no-haves cases on its own.
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // The shallow section is terminated by a flush: the client reads
  // shallow/unshallow lines until the flush, then expects the ACK/NAK phase.
  // Without it git dies with "expected shallow/unshallow, got NAK" (verified
  // against git 2.43's daemon: shallow line, flush, then the client sends
  // `done` and the server answers NAK + pack).
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) parts.push(flushPkt());
  const commonHaves = args.haves.filter((have) =>
    args.wants.some((want) => repo.isAncestor(have, want)),
  );
  if (commonHaves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of commonHaves) parts.push(pktLine(`ACK ${have} common\n`));
    parts.push(pktLine(`ACK ${commonHaves[commonHaves.length - 1]}\n`));
  }
  for (const packet of sideband(1, pack)) parts.push(packet);
  parts.push(flushPkt());
  return { status: 200, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { packets, consumed } = parsePktLines(body);
  const commands: PushCommand[] = [];
  let sidebandRequested = false;
  let reportRequested = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
    if (nul >= 0) {
      const caps = raw.slice(nul + 1).trim().split(/\s+/);
      if (caps.includes('side-band-64k')) sidebandRequested = true;
      if (caps.includes('report-status') || caps.includes('report-status-v2')) {
        reportRequested = true;
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  const reports: RefReport[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  // Unpack the pack (if any bytes follow the command list), even when every
  // update will be refused: the report must still say whether the unpack worked.
  const packBytes = body.subarray(consumed);
  const newObjects: Array<{ oid: string; type: GitObject['type']; data: Buffer }> = [];
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const entry of entries) newObjects.push(entry);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (unpackOk) {
    for (const entry of newObjects) {
      if (!repo.hasObject(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reports.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.hasObject(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: the new tip must descend from the old one.
    if (repo.isAncestor(command.oldOid, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  // Report-status, pkt-framed, terminated by a flush INSIDE the report stream
  // itself: real git reads report lines until that flush, and a stream that
  // just ends reads as "the remote end hung up unexpectedly". When sideband is
  // negotiated the whole framed report (flush included) rides band 1, and a
  // second flush ends the sideband stream.
  const reportLines: Buffer[] = [];
  reportLines.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`));
  if (reportRequested || true) {
    for (const report of reports) {
      reportLines.push(
        pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`),
      );
    }
  }
  reportLines.push(flushPkt());
  const report = Buffer.concat(reportLines);
  let responseBody: Buffer;
  if (sidebandRequested) {
    const parts = sideband(1, report);
    parts.push(flushPkt());
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = report;
  }
  return { status: 200, body: responseBody };
}

// ---------------------------------------------------------------- routing

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitHttpResult {
  return {
    status: 404,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  };
}

/**
 * Route one git smart-HTTP request. `segments` are the decoded path segments
 * after the leading `/` (e.g. ['adaiversen', 'repo.git', 'info/refs'] is
 * ['adaiversen', 'repo.git', 'info', 'refs']).
 */
export function handleGitHttp(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitHttpResult | null {
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return null;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const rest = segments.slice(2);
  const isInfoRefs = rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
  const service =
    rest.length === 1 && rest[0] === 'git-upload-pack'
      ? 'git-upload-pack'
      : rest.length === 1 && rest[0] === 'git-receive-pack'
        ? 'git-receive-pack'
        : null;
  if (!isInfoRefs && service === null) return null;
  // Only the token owner's repositories exist here; any other owner is a 404,
  // exactly like a missing repository (never a 403 that would leak existence).
  if (owner !== VIEWER_LOGIN) return notFound();
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();

  if (method === 'GET' && isInfoRefs) {
    const requested = query.get('service');
    if (requested === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] ?? '').trim() === 'version=2';
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v2 ? advertiseV2(repo) : advertiseV0Upload(repo),
      };
    }
    if (requested === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: advertiseV0Receive(repo),
      };
    }
    return notFound();
  }

  if (method === 'POST' && service === 'git-upload-pack') {
    try {
      const v2 = (headers['git-protocol'] ?? '').trim() === 'version=2';
      const result = v2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      return {
        status: result.status,
        contentType: 'application/x-git-upload-pack-result',
        body: result.body,
      };
    } catch {
      return {
        status: 400,
        contentType: 'application/x-git-upload-pack-result',
        body: Buffer.from('bad request\n', 'utf8'),
      };
    }
  }

  if (method === 'POST' && service === 'git-receive-pack') {
    try {
      const result = handleReceivePack(repo, body);
      return {
        status: result.status,
        contentType: 'application/x-git-receive-pack-result',
        body: result.body,
      };
    } catch {
      return {
        status: 400,
        contentType: 'application/x-git-receive-pack-result',
        body: Buffer.from('bad request\n', 'utf8'),
      };
    }
  }

  return notFound();
}

// Re-exported for the test harness.
export { parseCommit, parseTag, parseTree };
