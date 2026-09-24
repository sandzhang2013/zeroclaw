/** Import a skill folder or .zip. A package is one directory that contains SKILL.md. */

import { skillSlug } from './personalSkill.ts';

export type SkillPackageError =
  | 'missing'
  | 'ambiguous'
  | 'frontmatter'
  | 'name'
  | 'description'
  | 'bad-zip'
  | 'too-large';

export interface ImportedSkill {
  /** Directory slug sent to POST /api/user/skills. */
  name: string;
  /** YAML `name`, shown as the skill title. */
  title: string;
  description: string;
  body: string;
}

export type SkillPackageResult =
  | { ok: true; skill: ImportedSkill }
  | { ok: false; error: SkillPackageError };

const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;

export function skillImportErrorKey(error: SkillPackageError): string {
  return `workbench.skill_import_${error.replace('-', '_')}`;
}

/** Read YAML `name` and `description`. Both must be non-empty. */
export function parseSkillMarkdown(content: string): SkillPackageResult {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { ok: false, error: 'frontmatter' };
  const rest = normalized.slice(4);
  const splitAt = rest.indexOf('\n---\n');
  let frontmatter: string;
  let body: string;
  if (splitAt >= 0) {
    frontmatter = rest.slice(0, splitAt);
    body = rest.slice(splitAt + 5);
  } else if (rest.endsWith('\n---')) {
    frontmatter = rest.slice(0, -4);
    body = '';
  } else {
    return { ok: false, error: 'frontmatter' };
  }

  const fields = readNameAndDescription(frontmatter);
  const title = fields.name.trim();
  const description = fields.description.trim();
  if (!title) return { ok: false, error: 'name' };
  if (!description) return { ok: false, error: 'description' };
  return {
    ok: true,
    skill: {
      name: skillSlug(title),
      title,
      description,
      body,
    },
  };
}

export type LocatedSkill =
  | { ok: true; path: string }
  | { ok: false; error: 'missing' | 'ambiguous' };

/** Shallowest `SKILL.md`. Two files at that depth is ambiguous. */
export function locateSkillMarkdown(paths: readonly string[]): LocatedSkill {
  const candidates = paths
    .map(normalizePackagePath)
    .filter((path): path is string => path != null && isSkillMarkdown(path));
  if (candidates.length === 0) return { ok: false, error: 'missing' };
  const depth = Math.min(...candidates.map((path) => path.split('/').length));
  const shallow = candidates.filter((path) => path.split('/').length === depth);
  const path = shallow[0];
  if (shallow.length !== 1 || !path) return { ok: false, error: 'ambiguous' };
  return { ok: true, path };
}

export async function readSkillFromFiles(
  files: Iterable<PackageFile>,
): Promise<SkillPackageResult> {
  const listed = [...files];
  const located = locateSkillMarkdown(listed.map((file) => file.path));
  if (!located.ok) return located;
  const match = listed.find((file) => normalizePackagePath(file.path) === located.path);
  if (!match) return { ok: false, error: 'missing' };
  return parseSkillMarkdown(await match.text());
}

export async function readSkillFromZip(bytes: ArrayBuffer): Promise<SkillPackageResult> {
  if (bytes.byteLength > MAX_ZIP_BYTES) return { ok: false, error: 'too-large' };
  const opened = openZip(new Uint8Array(bytes));
  if (!opened.ok) return opened;
  const located = locateSkillMarkdown(opened.entries.map((entry) => entry.name));
  if (!located.ok) return located;
  const entry = opened.entries.find((item) => item.name === located.path);
  if (!entry) return { ok: false, error: 'missing' };
  const text = await entry.text();
  if (text == null) return { ok: false, error: entry.reason };
  return parseSkillMarkdown(text);
}

export interface PackageFile {
  path: string;
  text: () => Promise<string>;
}

interface ZipEntry {
  name: string;
  text: () => Promise<string | null>;
  reason: 'bad-zip' | 'too-large';
}

function isSkillMarkdown(path: string): boolean {
  if (path === 'SKILL.md') return true;
  if (path.startsWith('__MACOSX/') || path.split('/').includes('__MACOSX')) return false;
  return path.endsWith('/SKILL.md');
}

function normalizePackagePath(raw: string): string | null {
  const slash = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!slash || slash.startsWith('/') || /^[A-Za-z]:/.test(slash)) return null;
  const parts = slash.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function readNameAndDescription(src: string): { name: string; description: string } {
  let name = '';
  let description = '';
  let block: { key: 'name' | 'description'; parts: string[] } | null = null;

  const flush = () => {
    if (!block) return;
    const value = block.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (value) {
      if (block.key === 'name') name = value;
      else description = value;
    }
    block = null;
  };

  for (const line of src.split('\n')) {
    if (block) {
      if (line.startsWith(' ') || line.startsWith('\t') || line.trim() === '') {
        block.parts.push(line.trim());
        continue;
      }
      flush();
    }
    if (line.startsWith(' ') || line.startsWith('\t') || !line.includes(':')) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key !== 'name' && key !== 'description') continue;
    if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      block = { key, parts: [] };
      continue;
    }
    if (key === 'name') name = value;
    else description = value;
  }
  flush();
  return { name, description };
}

function openZip(bytes: Uint8Array): { ok: true; entries: ZipEntry[] } | { ok: false; error: SkillPackageError } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) return { ok: false, error: 'bad-zip' };
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total > MAX_ZIP_ENTRIES || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    return { ok: false, error: 'bad-zip' };
  }
  if (cdOffset + cdSize > bytes.length) return { ok: false, error: 'bad-zip' };

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
      return { ok: false, error: 'bad-zip' };
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) return { ok: false, error: 'bad-zip' };
    const name = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameEnd));
    const normalized = normalizePackagePath(name);
    cursor = nameEnd + extraLen + commentLen;
    if (!normalized || normalized.endsWith('/')) continue;
    entries.push({
      name: normalized,
      reason: uncompressedSize > MAX_SKILL_MD_BYTES || compressedSize > MAX_SKILL_MD_BYTES ? 'too-large' : 'bad-zip',
      text: async () => {
        if (flags & 1) return null;
        if (uncompressedSize > MAX_SKILL_MD_BYTES || compressedSize > MAX_SKILL_MD_BYTES) return null;
        return inflateEntry(bytes, view, localOffset, method, compressedSize);
      },
    });
  }
  return { ok: true, entries };
}

function findEocd(view: DataView, length: number): number {
  const min = Math.max(0, length - (22 + 0xffff));
  for (let offset = length - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLen = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLen === length) return offset;
  }
  return -1;
}

async function inflateEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
): Promise<string | null> {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > bytes.length) return null;
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (method === 0) return new TextDecoder('utf-8').decode(compressed);
  if (method !== 8 || typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
    if (inflated.byteLength > MAX_SKILL_MD_BYTES) return null;
    return new TextDecoder('utf-8').decode(inflated);
  } catch {
    return null;
  }
}
