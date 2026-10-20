import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  bytesToBase64,
  locateSkillMarkdown,
  parseSkillMarkdown,
  readSkillFromFiles,
  readSkillFromZip,
} from './skillPackage.ts';

const VALID = `---
name: flu-weekly
description: 按周汇总流感监测数据。
---

# 流感周报
`;

test('parseSkillMarkdown requires YAML name and description', () => {
  const parsed = parseSkillMarkdown(VALID);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.skill.name, 'flu-weekly');
  assert.equal(parsed.skill.title, 'flu-weekly');
  assert.equal(parsed.skill.description, '按周汇总流感监测数据。');
  assert.match(parsed.skill.body, /流感周报/);

  assert.deepEqual(parseSkillMarkdown('# 只有正文\n'), { ok: false, error: 'frontmatter' });
  assert.deepEqual(
    parseSkillMarkdown('---\ndescription: 只有说明\n---\n'),
    { ok: false, error: 'name' },
  );
  assert.deepEqual(
    parseSkillMarkdown('---\nname: flu-weekly\n---\n'),
    { ok: false, error: 'description' },
  );
  const padded = parseSkillMarkdown('---   \nname: flu-weekly\ndescription: 说明\n---\t\n');
  assert.equal(padded.ok, true);
  if (padded.ok) assert.equal(padded.skill.title, 'flu-weekly');
  const indented = parseSkillMarkdown('---\nname: flu-weekly\ndescription: |\n  近\n  ---\n  仍在说明\n---\n正文\n');
  assert.equal(indented.ok, true);
  if (indented.ok) {
    assert.match(indented.skill.description, /仍在说明/);
    assert.match(indented.skill.body, /正文/);
  }
  assert.deepEqual(parseSkillMarkdown('---\nname: flu-weekly\ndescription: 说明\n----\n'), {
    ok: false,
    error: 'frontmatter',
  });
});

test('parseSkillMarkdown reads a block-scalar description', () => {
  const parsed = parseSkillMarkdown(`---
name: 流感周报
description: |
  近 8 周
  趋势
---
正文
`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.skill.title, '流感周报');
  assert.equal(parsed.skill.description, '近 8 周 趋势');
});

test('locateSkillMarkdown picks the shallowest SKILL.md', () => {
  assert.deepEqual(
    locateSkillMarkdown(['notes.md', 'flu/scripts/run.py', 'flu/SKILL.md']),
    { ok: true, path: 'flu/SKILL.md' },
  );
  assert.deepEqual(locateSkillMarkdown(['README.md']), { ok: false, error: 'missing' });
  assert.deepEqual(
    locateSkillMarkdown(['a/SKILL.md', 'b/SKILL.md']),
    { ok: false, error: 'ambiguous' },
  );
  assert.deepEqual(
    locateSkillMarkdown(['../SKILL.md', '__MACOSX/flu/SKILL.md']),
    { ok: false, error: 'missing' },
  );
});

test('readSkillFromFiles keeps scripts next to SKILL.md', async () => {
  const parsed = await readSkillFromFiles([
    packageFile('flu/SKILL.md', VALID),
    packageFile('flu/scripts/compute.py', 'print(1)\n'),
    packageFile('flu/references/usage.md', '# usage\n'),
    packageFile('other/README.md', 'skip\n'),
    packageFile('flu/.DS_Store', 'noise'),
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const paths = parsed.skill.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['SKILL.md', 'references/usage.md', 'scripts/compute.py']);
});

test('readSkillFromFiles rejects a folder without a valid SKILL.md', async () => {
  const missing = await readSkillFromFiles([
    packageFile('flu/README.md', '# hi'),
  ]);
  assert.deepEqual(missing, { ok: false, error: 'missing' });

  const bare = await readSkillFromFiles([
    packageFile('flu/SKILL.md', '# 没有 YAML\n'),
  ]);
  assert.deepEqual(bare, { ok: false, error: 'frontmatter' });
});

test('readSkillFromZip reads SKILL.md from a stored or deflated archive', async () => {
  const stored = await readSkillFromZip(zipBytes([
    { name: 'flu-weekly/SKILL.md', data: Buffer.from(VALID) },
    { name: 'flu-weekly/scripts/compute.py', data: Buffer.from('print(1)\n') },
    { name: 'notes.txt', data: Buffer.from('outside') },
  ], 0).buffer);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(stored.skill.description, '按周汇总流感监测数据。');
    assert.deepEqual(
      stored.skill.files.map((file) => file.path).sort(),
      ['SKILL.md', 'scripts/compute.py'],
    );
  }

  const deflated = await readSkillFromZip(
    zipBytes([{ name: 'flu-weekly/SKILL.md', data: Buffer.from(VALID) }], 8).buffer,
  );
  assert.equal(deflated.ok, true);

  const empty = await readSkillFromZip(zipBytes([{ name: 'flu-weekly/README.md', data: Buffer.from('x') }], 0).buffer);
  assert.deepEqual(empty, { ok: false, error: 'missing' });
  assert.deepEqual(await readSkillFromZip(new TextEncoder().encode('not a zip').buffer), {
    ok: false,
    error: 'bad-zip',
  });
});

test('bytesToBase64 round-trips a buffer larger than one chunk', () => {
  const bytes = Buffer.alloc(100_000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length % 4, 0);
  const decoded = Buffer.from(encoded, 'base64');
  assert.equal(decoded.length, bytes.length);
  assert.ok(decoded.equals(bytes));
});

test('readSkillFromZip allows a file over 1 MB and rejects an archive over 8 MB', async () => {
  const skill = Buffer.concat([Buffer.from(VALID), Buffer.alloc(1024 * 1024 + 1, 0x61)]);
  const parsed = await readSkillFromZip(zipBytes([
    { name: 'flu-weekly/SKILL.md', data: skill },
  ], 0).buffer);
  assert.equal(parsed.ok, true);

  const over = new ArrayBuffer(8 * 1024 * 1024 + 1);
  assert.deepEqual(await readSkillFromZip(over), { ok: false, error: 'too-large' });
});

test('readSkillFromZip allows a small archive whose file expands past 8 MB', async () => {
  const skill = Buffer.concat([Buffer.from(VALID), Buffer.alloc(9 * 1024 * 1024, 0x61)]);
  const zip = zipBytes([{ name: 'flu-weekly/SKILL.md', data: skill }], 8);
  assert.ok(zip.byteLength < 8 * 1024 * 1024);
  const parsed = await readSkillFromZip(zip.buffer);
  assert.equal(parsed.ok, true);
});

function packageFile(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    text: async () => text,
    bytes: async () => bytes,
  };
}

function zipBytes(files: { name: string; data: Buffer }[], method: 0 | 8): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const payload = method === 8 ? deflateRawSync(file.data) : file.data;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(payload.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      payload,
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(payload.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...locals, central, eocd]));
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}
