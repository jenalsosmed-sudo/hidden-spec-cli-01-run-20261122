// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers (exact,
// trailing whitespace ignored, both sides trimmed), and writes every change or none.
// The command line, output and exit codes, safe paths, format detection, JSON edits and
// the all-or-nothing write follow SPEC.md sections 1 to 4, 9 and 10; the three text
// formats and the three-tier matching are sections 5 to 8.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A file a created edit writes: LF breaks, ended by a line break when it has lines. */
function createdText(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, as [old, new] pairs, for the `R old -> new` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: matching lines at three tiers ------------------------------------------

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `file` at `tier`, at or after `from`; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length - from) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at least once. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The replacement lines for N. A context line (index j of N maps through `ctx` to an
 * index of O) is written as the file's own matched line, never the patch's. At tier 2
 * every other non-blank line of N that starts with P (the leading spaces and tabs of
 * O's first line) has that P replaced by F (those of the file's first matched line).
 */
function buildReplacement(file: string[], at: number, o: string[], n: string[], tier: number, ctx: Map<number, number> | null): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(file[at]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  for (let j = 0; j < n.length; j++) {
    const ci = ctx?.get(j);
    if (ci !== undefined) {
      out.push(file[at + ci]!);
      continue;
    }
    let line = n[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

/** A hunk or chunk body reduced to its old lines O, new lines N and context map. */
interface Body {
  o: string[];
  n: string[];
  ctx: Map<number, number>;
}

function bodyOf(body: string[]): Body {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      ctx.set(n.length, o.length);
      o.push(text);
      n.push(text);
    } else if (b[0] === '-') {
      o.push(b.slice(1));
    } else if (b[0] === '+') {
      n.push(b.slice(1));
    }
    // '\' lines carry no line of their own.
  }
  return { o, n, ctx };
}

// ---- Section 9: JSON edits ---------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ------------------------------------------------------------

interface Hunk {
  a: number;
  body: Body;
  /** A `\` line follows the hunk's last context or `+` line (used when its match runs to the end of the file). */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (used for a created file's final break). */
  noEolPlus: boolean;
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const GIT_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed; a/b- stripped; /dev/null is no file. */
function cleanDiffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseError(line: number): Exit2 {
  return new Exit2(`error: parse ${line}`);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const flush = (): void => {
    if (cur !== null) edits.push(unifiedEdit(cur, strict));
    cur = null;
    inHeader = false;
  };
  const fresh = (gitOld: string | null, gitNew: string | null): UniSection => ({
    gitOld,
    gitNew,
    oldPath: null,
    newPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_RE.exec(l);
      if (m === null) throw parseError(i + 1);
      flush();
      cur = fresh(m[1]!, m[2]!);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw parseError(i + 1);
      if (cur === null) throw parseError(i + 1);
      inHeader = false;
      i += 1;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      let noEol = false;
      let noEolPlus = false;
      let last = -1;
      let lastPlus = -1;
      for (let k = 0; k < raw.length; k++) {
        const b = raw[k]!;
        if (b === '' || b[0] === ' ' || b[0] === '+') last = k;
        if (b[0] === '+') lastPlus = k;
      }
      if (last >= 0 && raw[last + 1] !== undefined && raw[last + 1]![0] === '\\') noEol = true;
      if (lastPlus >= 0 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]![0] === '\\') noEolPlus = true;
      cur.hunks.push({ a: Number(m[1]), body: bodyOf(raw), noEol, noEolPlus });
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = cleanDiffPath(l.slice(4));
        cur.newPath = cleanDiffPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      flush();
      cur = fresh(null, null);
      inHeader = true;
      cur.oldPath = cleanDiffPath(l.slice(4));
      cur.newPath = cleanDiffPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw parseError(i + 2);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  flush();
  return edits;
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const old = sec.hasPair ? sec.oldPath : (sec.renameFrom ?? sec.gitOld);
  const nw = sec.hasPair ? sec.newPath : (sec.renameTo ?? sec.gitNew);
  const isCreate = old === null || sec.newFile;
  const isDelete = !isCreate && (nw === null || sec.delFile);
  const isMove = !isCreate && !isDelete && old !== null && nw !== null && old !== nw;
  if (isCreate && nw === null) return () => {};
  if (!isCreate && !isDelete && !isMove && old === null) return () => {};
  return (tree) => {
    if (isCreate) {
      const p = nw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        const raw = hunkPlusLines(h);
        plus.push(...raw.lines);
        if (raw.sawPlus) noEol = raw.noEolAfterLast;
      }
      tree.now.set(p, plus.length === 0 ? '' : `${plus.join('\n')}${noEol ? '' : '\n'}`);
      return;
    }
    if (isDelete) {
      const p = old!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const o = old!;
      const n = nw!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const content = tree.get(o);
      if (content === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const f = splitFile(content);
      applyHunks(f, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, joinFile(f));
      tree.moves.push([o, n]);
      return;
    }
    const p = old!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const content = tree.get(p);
    if (content === null) throw new Fail('missing', p);
    const f = splitFile(content);
    applyHunks(f, sec.hunks, strict, p);
    tree.now.set(p, joinFile(f));
  };
}

/**
 * The '+' lines of a hunk, in order, plus whether a '\' line follows its last '+' line.
 * The hunk's body (O/N/context) no longer carries the raw lines, so the '+' lines are
 * recovered from N minus its context lines: N holds context lines and '+' lines in body
 * order, and `ctx` marks which N entries are context lines.
 */
function hunkPlusLines(h: Hunk): { lines: string[]; sawPlus: boolean; noEolAfterLast: boolean } {
  const lines: string[] = [];
  let sawPlus = false;
  for (let j = 0; j < h.body.n.length; j++) {
    if (!h.body.ctx.has(j)) {
      lines.push(h.body.n[j]!);
      sawPlus = true;
    }
  }
  return { lines, sawPlus, noEolAfterLast: h.noEolPlus };
}

/** Apply a section's hunks in order to a file's lines, tracking the offset d (section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctx } = h.body;
    if (o.length > 0) {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, o, n, found.tier, ctx);
      f.lines.splice(best, o.length, ...repl);
      if (atEnd) f.final = !h.noEol;
    } else {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...n);
      if (atEnd) f.final = !h.noEol;
    }
    d += n.length - o.length;
  }
}

// ---- Section 7: SEARCH/REPLACE blocks ------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw parseError(searchIdx + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw parseError(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let m = searchIdx - 1; m > prevReplace; m--) {
      const t = lines[m]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw parseError(searchIdx + 1);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (oldLines.length === 0) {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, createdText(newLines));
      return;
    }
    if (!safe(path)) throw new Fail('unsafe', path);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = splitFile(content);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildReplacement(f.lines, at, oldLines, newLines, found.tier, null);
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

// ---- Section 8: V4A patches ----------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
  current: V4aChunk | null;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);
  const edits: Edit[] = [];
  let section: V4aSection | null = null;
  const finishSection = (): void => {
    if (section === null) return;
    if (section.kind === 'add') {
      while (section.lines.length > 0 && blank(section.lines[section.lines.length - 1]!)) section.lines.pop();
    }
    if (section.kind === 'update') {
      if (section.current !== null) {
        section.chunks.push(section.current);
        section.current = null;
      }
      const lastChunk = section.chunks[section.chunks.length - 1];
      if (lastChunk !== undefined && !lastChunk.eof) {
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      if (section.chunks.length === 0 && section.moveTo === null) throw parseError(section.startLine);
    }
    edits.push(v4aEdit(section, strict));
    section = null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (section === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      if (l.startsWith('*** Add File: ')) {
        section = { kind: 'add', path: l.slice(14).trim(), startLine: i + 1, lines: [], moveTo: null, chunks: [], current: null };
        i += 1;
        continue;
      }
      if (l.startsWith('*** Delete File: ')) {
        section = { kind: 'delete', path: l.slice(17).trim(), startLine: i + 1, lines: [], moveTo: null, chunks: [], current: null };
        i += 1;
        continue;
      }
      if (l.startsWith('*** Update File: ')) {
        section = { kind: 'update', path: l.slice(17).trim(), startLine: i + 1, lines: [], moveTo: null, chunks: [], current: null };
        i += 1;
        continue;
      }
      throw parseError(i + 1);
    }
    if (isV4aSectionStart(l)) {
      finishSection();
      continue;
    }
    if (section.kind === 'add') {
      if (l.startsWith('+')) {
        section.lines.push(l);
        i += 1;
        continue;
      }
      if (blank(l)) {
        section.lines.push(l);
        i += 1;
        continue;
      }
      throw parseError(i + 1);
    }
    if (section.kind === 'delete') {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw parseError(i + 1);
    }
    // Update File section.
    if (l.startsWith('*** Move to: ')) {
      if (section.moveTo !== null || section.chunks.length > 0 || section.current !== null) throw parseError(i + 1);
      section.moveTo = l.slice(13).trim();
      i += 1;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (section.current === null) throw parseError(i + 1);
      section.current.eof = true;
      section.chunks.push(section.current);
      section.current = null;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (section.current !== null) {
        section.chunks.push(section.current);
        section.current = null;
      }
      const anchor = l.slice(2).trim();
      section.current = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      i += 1;
      continue;
    }
    if (blank(l) && section.current === null && section.chunks.length > 0) {
      // Blank lines after an end-of-file chunk are trailing blanks of the section.
      i += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (section.current === null) {
        if (section.chunks.length > 0) throw parseError(i + 1);
        section.current = { anchor: null, body: [], eof: false };
      }
      section.current.body.push(l);
      i += 1;
      continue;
    }
    throw parseError(i + 1);
  }
  finishSection();
  return edits;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (sec.kind === 'add') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      for (const raw of sec.lines) out.push(raw.startsWith('+') ? raw.slice(1) : '');
      tree.now.set(p, createdText(out));
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    const content = tree.get(p);
    if (content === null) throw new Fail('missing', p);
    let newPath: string | null = null;
    if (sec.moveTo !== null) {
      newPath = sec.moveTo;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    }
    const f = splitFile(content);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(f.lines, cursor, chunk.anchor, strict);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n, ctx } = bodyOf(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...n);
        cursor = pos + n.length;
      } else {
        const found = findTier(f.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        const occ = chunk.eof ? found.occ.filter((pos) => pos + o.length === f.lines.length) : found.occ;
        if (occ.length === 0) throw new Fail('no-match', p);
        const at = occ[0]!;
        const repl = buildReplacement(f.lines, at, o, n, found.tier, ctx);
        f.lines.splice(at, o.length, ...repl);
        cursor = at + repl.length;
      }
    }
    const out = joinFile(f);
    if (newPath !== null) {
      tree.now.set(p, null);
      tree.now.set(newPath, out);
      tree.moves.push([p, newPath]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** The first line at or after `from` equal to `anchor` at the first tier with one, or -1. */
function findSingleLine(file: string[], from: number, anchor: string, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < file.length; i++) {
      if (norm(file[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return -1;
}

// ---- Section 1, 2 and 10: invocation, output and exit codes ---------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.get(o);
    const wasN = tree.original(n);
    const nowN = tree.now.get(n);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && nowN !== undefined) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    // Deletions first: a patch may delete a file `a` and create `a/b` under it.
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
