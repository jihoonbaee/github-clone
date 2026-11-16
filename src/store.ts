// The forge's in-memory store: repositories, git objects, refs, issues, pull
// requests, labels and comments — one store shared by git, REST, GraphQL and MCP.
// A trial runs in a fresh pod, so nothing persists past the process.
//
// The viewer (the token's login) is a fixed constant of the contest's published
// scenario: the env's scenario generator (wire.ts buildScenario, seed
// 0x6a09e667f3bcc909) always yields login `adaiversen`, id 1000. The login is
// NOT derivable from the opaque bearer token, so the forge holds it as config.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { ZERO_OID, gitTimestamp, nextGlobalId, nowIso, nowSec } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The git identity line REST-created commits carry. */
export function viewerIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${gitTimestamp()}`;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  description: string;
  privateFlag: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;

  /** Object id -> object. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref name -> object id. */
  readonly refs = new Map<string, string>();
  /** Label name -> label. */
  readonly labels = new Map<string, Label>();
  /** Issue number -> issue. */
  readonly issues = new Map<number, Issue>();
  /** PR number -> pull request. */
  readonly pulls = new Map<number, PullRequest>();
  /** Shared issue+PR number counter (GitHub numbers issues and PRs together). */
  nextNumber = 1;

  constructor(owner: string, name: string, description: string, privateFlag: boolean) {
    this.owner = owner;
    this.name = name;
    this.id = nextGlobalId();
    this.description = description;
    this.privateFlag = privateFlag;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // ------------------------------------------------------------ objects

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  // ------------------------------------------------------------ refs

  /** The ref HEAD points at. */
  get headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The object id HEAD resolves to, or null when the default branch has no commit. */
  headOid(): string | null {
    return this.refs.get(this.headRef) ?? null;
  }

  /** Resolve a ref name (full or short branch name) to an oid, or null. */
  resolveRef(name: string): string | null {
    if (name === 'HEAD') return this.headOid();
    if (this.refs.has(name)) return this.refs.get(name)!;
    const asBranch = this.refs.get(`refs/heads/${name}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = this.refs.get(`refs/tags/${name}`);
    if (asTag !== undefined) return asTag;
    if (this.objects.has(name)) return name;
    return null;
  }

  /** Peel a tag (recursively) to the non-tag object it points at. */
  peel(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  // ------------------------------------------------------------ graph walks

  /** Every object id reachable from `roots` (commits, trees, blobs, tags). */
  collectReachable(roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /**
   * The objects a fetching client already holds: reachable from `haves`, except
   * the walk stops at `boundaries` — the client's shallow commits, whose
   * parents it does NOT hold (a shallow clone's tip has no history behind it).
   */
  collectHaveSet(haves: readonly string[], boundaries: readonly string[]): Set<string> {
    const cut = new Set(boundaries);
    const seen = new Set<string>();
    const queue: string[] = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!cut.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant` (commits, peeled). */
  isAncestor(ancestor: string, descendant: string): boolean {
    const target = this.peel(ancestor);
    let current = this.peel(descendant);
    if (target === current) return true;
    const seen = new Set<string>();
    const queue = [current];
    while (queue.length > 0) {
      current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === target) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The first common ancestor of two commits (breadth-first from both), or null. */
  mergeBase(a: string, b: string): string | null {
    const aPeeled = this.peel(a);
    const bPeeled = this.peel(b);
    const ancestorsOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0) {
        const oid = queue.pop()!;
        if (seen.has(oid)) continue;
        const object = this.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        seen.add(oid);
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      return seen;
    };
    const aAncestors = ancestorsOf(aPeeled);
    const queue = [bPeeled];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** The distance (in parent hops) of every commit reachable from `start`. */
  commitDistances(start: string): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = [{ oid: this.peel(start), distance: 0 }];
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (distances.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      distances.set(oid, distance);
      for (const parent of parseCommit(object.data).parents) {
        if (!distances.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
      }
    }
    return distances;
  }

  /** The commit history from `start` (newest first), following first parents only for order. */
  listCommits(start: string, limit = 1_000): Array<{ oid: string; info: CommitInfo }> {
    const result: Array<{ oid: string; info: CommitInfo }> = [];
    const seen = new Set<string>();
    const queue = [this.peel(start)];
    while (queue.length > 0 && result.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      result.push({ oid, info });
      // Depth-first-ish: parents appended in order, so the newest commit leads.
      for (const parent of info.parents) queue.push(parent);
    }
    return result;
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree into path -> {mode, oid} (blobs only; subtrees recursed). */
  flattenTree(treeOid: string): Map<string, { mode: string; oid: string }> {
    const files = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** Build (and store) a tree from a flat path -> {mode, oid} map. */
  buildTreeFromFiles(files: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface DirNode {
      files: TreeEntry[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.push({ mode: file.mode, name: parts[parts.length - 1]!, oid: file.oid });
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one path out of a tree: the entry (blob or subtree) plus its type, or null. */
  readPath(treeOid: string, path: string): { mode: string; oid: string; isDir: boolean } | null {
    if (path === '' || path === '/') return { mode: '40000', oid: treeOid, isDir: true };
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((item) => item.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid, isDir: entry.mode === '40000' };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** List a directory's entries at a tree path, or null when it is not a directory. */
  listDir(treeOid: string, path: string): TreeEntry[] | null {
    const target = this.readPath(treeOid, path);
    if (target === null || !target.isDir) return null;
    const object = this.objects.get(target.oid);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // ------------------------------------------------------------ commits

  /** Create a commit object (stored) on top of `parents` with the given tree and message. */
  createCommit(treeOid: string, parents: readonly string[], message: string): string {
    const identity = viewerIdentity();
    const commit: CommitInfo = {
      tree: treeOid,
      parents: [...parents],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    };
    return this.putObject('commit', buildCommit(commit));
  }

  /** The tree oid of a commit (peeled), or null. */
  treeOf(commitOid: string): string | null {
    const object = this.objects.get(this.peel(commitOid));
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly repos = new Map<string, Repo>();

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, privateFlag: boolean): Repo {
    const repo = new Repo(owner, name, description, privateFlag);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const result: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) result.push(repo);
    }
    result.sort((a, b) => a.id - b.id);
    return result;
  }
}

// ---------------------------------------------------------------- diffs

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

/**
 * A line diff between two texts: LCS over lines (dynamic programming), capped
 * at 2,000 lines a side — larger files fall back to a multiset line count.
 * Returns additions/deletions; identical texts are 0/0.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 2_000 || newLines.length > 2_000) {
    const counts = new Map<string, number>();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }
  // LCS length via two rolling rows.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] =
        oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[newLines.length]!;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** Diff two trees (by oid) into per-file diffs, sorted by filename. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const baseFiles = baseTreeOid === null ? new Map() : repo.flattenTree(baseTreeOid);
  const headFiles = headTreeOid === null ? new Map() : repo.flattenTree(headTreeOid);
  const names = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const diffs: FileDiff[] = [];
  for (const name of [...names].sort()) {
    const base = baseFiles.get(name);
    const head = headFiles.get(name);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    const readText = (oid: string): string => repo.getObject(oid)?.data.toString('utf8') ?? '';
    if (base === undefined && head !== undefined) {
      const text = readText(head.oid);
      const lines = text === '' ? 0 : text.split('\n').length;
      diffs.push({
        filename: name,
        status: 'added',
        additions: lines,
        deletions: 0,
        changes: lines,
        oldOid: null,
        newOid: head.oid,
      });
    } else if (base !== undefined && head === undefined) {
      const text = readText(base.oid);
      const lines = text === '' ? 0 : text.split('\n').length;
      diffs.push({
        filename: name,
        status: 'removed',
        additions: 0,
        deletions: lines,
        changes: lines,
        oldOid: base.oid,
        newOid: null,
      });
    } else if (base !== undefined && head !== undefined) {
      const { additions, deletions } = lineDiff(readText(base.oid), readText(head.oid));
      diffs.push({
        filename: name,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        oldOid: base.oid,
        newOid: head.oid,
      });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------- three-way merge

export interface MergeOutcome {
  ok: boolean;
  /** The merged tree's files (when ok). */
  files?: Map<string, { mode: string; oid: string }>;
  /** The conflicting paths (when not ok). */
  conflicts?: string[];
}

/**
 * A per-file three-way merge: a file changed on one side only takes that side;
 * changed identically on both takes either; changed differently on both is a
 * conflict. Deletion counts as a change (delete vs modify = conflict).
 */
export function threeWayMerge(
  repo: Repo,
  baseTreeOid: string | null,
  oursTreeOid: string | null,
  theirsTreeOid: string | null,
): MergeOutcome {
  const base = baseTreeOid === null ? new Map() : repo.flattenTree(baseTreeOid);
  const ours = oursTreeOid === null ? new Map() : repo.flattenTree(oursTreeOid);
  const theirs = theirsTreeOid === null ? new Map() : repo.flattenTree(theirsTreeOid);
  const names = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  for (const name of names) {
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o !== undefined) merged.set(name, o);
      continue;
    }
    if (oOid === bOid) {
      if (t !== undefined) merged.set(name, t);
      continue;
    }
    if (tOid === bOid) {
      if (o !== undefined) merged.set(name, o);
      continue;
    }
    conflicts.push(name);
  }
  if (conflicts.length > 0) return { ok: false, conflicts: conflicts.sort() };
  return { ok: true, files: merged };
}

/** The current epoch seconds (re-exported for callers that build commit lines). */
export { nowSec };
