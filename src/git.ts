// Git object model, pack files and pkt-lines, written against the plain
// object formats the smart-HTTP client speaks: SHA-1 ids, zlib-compressed
// pack entries without deltas, and the v2 fetch negotiation.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: SHA-1 over `<type> <size>\0` plus the raw bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
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

export function buildCommit(view: CommitView): Buffer {
  const lines: string[] = [`tree ${view.tree}`];
  for (const parent of view.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${view.author}`);
  lines.push(`committer ${view.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${view.message}`, 'utf8');
}

/** The identity line for commits this forge authors itself. */
export function forgeIdentity(): string {
  const ts = Math.floor(Date.now() / 1000);
  return `adaiversen <adaiversen@users.noreply.github.com> ${ts} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in `/`. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- trees as flat paths

/** A flattened tree: every file path to its blob id, directories expanded. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Build (and store) the tree for a flat path map, bottom-up. Returns the root
 * tree id. Intermediate directory trees are stored as they are created.
 */
export function buildTreeForPaths(repo: Repo, paths: Map<string, string>): string {
  // Group paths by their directory, deepest first, building one tree per dir.
  const byDir = new Map<string, Map<string, { mode: string; oid: string }>>();
  const ensureDir = (dir: string): Map<string, { mode: string; oid: string }> => {
    let found = byDir.get(dir);
    if (found === undefined) {
      found = new Map();
      byDir.set(dir, found);
    }
    return found;
  };
  for (const [path, oid] of paths) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    ensureDir(dir).set(name, { mode: '100644', oid });
    // Every ancestor directory needs a tree of its own, even when it holds
    // no files directly (it only contains subdirectories).
    let ancestor = dir;
    while (ancestor !== '') {
      ancestor = ancestor.includes('/') ? ancestor.slice(0, ancestor.lastIndexOf('/')) : '';
      ensureDir(ancestor);
    }
  }
  // Directories, deepest first, so a parent can reference its child's tree.
  const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  const dirs = [...byDir.keys()].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1));
  const treeOidByDir = new Map<string, string>();
  for (const dir of dirs) {
    const entries: TreeEntry[] = [];
    for (const [name, ref] of ensureDir(dir)) {
      entries.push({ mode: ref.mode, name, oid: ref.oid });
    }
    // Subdirectories of this dir contribute tree entries.
    for (const [childDir, childOid] of treeOidByDir) {
      const parent = childDir.includes('/') ? childDir.slice(0, childDir.lastIndexOf('/')) : '';
      if (parent === dir) {
        const name = childDir.includes('/') ? childDir.slice(childDir.lastIndexOf('/') + 1) : childDir;
        entries.push({ mode: '40000', name, oid: childOid });
      }
    }
    const data = buildTree(entries);
    const oid = storeObject(repo, 'tree', data);
    treeOidByDir.set(dir, oid);
  }
  const root = treeOidByDir.get('') ?? storeObject(repo, 'tree', buildTree([]));
  return root;
}

// ---------------------------------------------------------------- reachability

export interface Reachable {
  /** Commit ids reachable from the roots, with their generation distance. */
  commits: Map<string, number>;
  /** Every object id in the closure (commits, trees, blobs, tags). */
  objects: Set<string>;
}

/**
 * The closure of objects reachable from `roots`. With `maxDepth`, commits at
 * generation `maxDepth` and beyond are cut off (depth 1 = the tips only).
 * `exclude` holds object ids the far side already has: their ancestors are
 * pruned, except that a shallow boundary in `excludeShallow` prunes only
 * itself, never its ancestors.
 */
export function reachable(
  repo: Repo,
  roots: string[],
  options: { maxDepth?: number; exclude?: Set<string>; excludeShallow?: Set<string> } = {},
): Reachable {
  const commits = new Map<string, number>();
  const objects = new Set<string>();
  const exclude = options.exclude ?? new Set<string>();
  const excludeShallow = options.excludeShallow ?? new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (root === ZERO_OID) continue;
    queue.push({ oid: root, depth: 0 });
  }
  const seen = new Set<string>();
  const visitObject = (oid: string): void => {
    if (objects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    objects.add(oid);
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      visitObject(tag.object);
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    // A held commit that is not a shallow boundary prunes its whole ancestry.
    if (exclude.has(oid) && !excludeShallow.has(oid)) continue;
    if (options.maxDepth !== undefined && depth >= options.maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      visitObject(oid);
      if (tag.type === 'commit') queue.push({ oid: tag.object, depth });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    if (excludeShallow.has(oid)) {
      // Held as a shallow boundary: the client has this commit but none of
      // its history, so walk through it without sending it.
      for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
      continue;
    }
    commits.set(oid, depth);
    objects.add(oid);
    // The commit's tree and everything under it travels with it.
    const collectTree = (treeOid: string): void => {
      if (objects.has(treeOid)) return;
      const treeObj = repo.objects.get(treeOid);
      if (treeObj === undefined) return;
      objects.add(treeOid);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') collectTree(entry.oid);
        else objects.add(entry.oid);
      }
    };
    collectTree(view.tree);
    for (const parent of view.parents) {
      if (!commits.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return { commits, objects };
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits, or null when unrelated. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
  while (queueA.length > 0) {
    const { oid, depth } = queueA.shift()!;
    if (fromA.has(oid)) continue;
    fromA.set(oid, depth);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push({ oid: parent, depth: depth + 1 });
  }
  const queueB: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const { oid, depth } = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = fromA.get(oid);
    if (depthA !== undefined) {
      const score = depthA + depth;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push({ oid: parent, depth: depth + 1 });
  }
  return best;
}

export interface MergeResult {
  conflict: boolean;
  /** The merged flat path map, valid only when there is no conflict. */
  paths: Map<string, string>;
}

/** A three-way merge of the trees at `head` and `baseTip` over `base`. */
export function threeWayMerge(repo: Repo, base: string, head: string, baseTip: string): MergeResult {
  const baseTree = flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const headTree = flattenTree(repo, parseCommit(repo.objects.get(head)!.data).tree);
  const tipTree = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const merged = new Map<string, string>();
  const allPaths = new Set([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
  for (const path of allPaths) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const t = tipTree.get(path);
    if (h === b) {
      if (t !== undefined) merged.set(path, t);
    } else if (t === b) {
      if (h !== undefined) merged.set(path, h);
    } else if (h === t) {
      if (t !== undefined) merged.set(path, t);
    } else {
      return { conflict: true, paths: new Map() };
    }
  }
  return { conflict: false, paths: merged };
}

// ---------------------------------------------------------------- pack files

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** Read a pack (version 2 or 3) of plain objects; delta entries are rejected. */
export function readPack(buf: Buffer): PackObject[] {
  if (buf.length < 12) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack file');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: PackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length) throw new Error('pack truncated');
    let byte = buf[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) throw new Error('ofs-delta packs are not supported');
    if (typeId === 7) throw new Error('ref-delta packs are not supported');
    const type = PACK_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    // The stream's end is the smallest prefix that inflates cleanly
    // (inflateSync stops at the first stream and ignores what follows).
    const consumed = zlibConsumed(buf.subarray(offset));
    const data = inflateSync(buf.subarray(offset, offset + consumed));
    offset += consumed;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = hashObject(type, data);
    objects.push({ oid, type, data });
  }
  return objects;
}

/** How many bytes of `buf` one zlib stream occupies (header + deflate + adler). */
function zlibConsumed(buf: Buffer): number {
  // Binary-search the smallest prefix that inflates cleanly: a prefix that
  // ends mid-stream throws, a prefix past the stream end returns the stream.
  let low = 2;
  let high = buf.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buf.subarray(0, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

/** Write a pack (version 2) of plain objects, with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of list) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The 0002 "response-end" packet that terminates a stateless HTTP reply. */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/**
 * Parse pkt-lines from the front of `buf`. Stops at the first flush/delim
 * and returns the bytes that follow it as `rest` (the pack after a
 * receive-pack command list). Throws on a malformed length prefix.
 */
export function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const prefix = buf.subarray(offset, offset + 4).toString('ascii');
    if (prefix === '0000') return { packets, rest: buf.subarray(offset + 4) };
    if (prefix === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (prefix === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(prefix, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buf.length) {
      throw new Error(`malformed pkt-line prefix ${JSON.stringify(prefix)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error('truncated pkt-line stream');
  return { packets, rest: Buffer.alloc(0) };
}

export function pktLinesText(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}
