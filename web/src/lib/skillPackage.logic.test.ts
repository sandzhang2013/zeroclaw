import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
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

test('readSkillFromFiles rejects a folder without a valid SKILL.md', async () => {
  const missing = await readSkillFromFiles([
    { path: 'flu/README.md', text: async () => '# hi' },
  ]);
  assert.deepEqual(missing, { ok: false, error: 'missing' });

  const bare = await readSkillFromFiles([
    { path: 'flu/SKILL.md', text: async () => '# 没有 YAML\n' },
  ]);
  assert.deepEqual(bare, { ok: false, error: 'frontmatter' });
});

test('readSkillFromZip reads SKILL.md from a stored or deflated archive', async () => {
  const stored = await readSkillFromZip(zipBytes([{ name: 'flu-weekly/SKILL.md', data: Buffer.from(VALID) }], 0).buffer);
  assert.equal(stored.ok, true);
  if (stored.ok) assert.equal(stored.skill.description, '按周汇总流感监测数据。');

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
