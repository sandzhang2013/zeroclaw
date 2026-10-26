import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');

function catalogKeys(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = line.match(/^\s+'([^']+)':\s*(.*)$/);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) out.set(key, value);
  }
  return out;
}

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, files);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith('.test.ts') && name !== 'i18n.ts') files.push(full);
  }
  return files;
}

test('dashboard t() keys have Chinese text and keep placeholders', () => {
  const src = fs.readFileSync(path.join(here, 'i18n.ts'), 'utf8');
  const zhStart = src.indexOf('  zh: {');
  const enStart = src.indexOf('\n  en: {');
  assert.ok(zhStart >= 0 && enStart > zhStart);
  const zh = catalogKeys(src.slice(zhStart, enStart));
  const en = catalogKeys(src.slice(enStart));

  const used = new Set<string>();
  for (const file of sourceFiles(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt(?:Locale)?\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) {
      const key = match[1];
      if (key !== undefined) used.add(key);
    }
  }

  const missing = [...used].filter((key) => !zh.has(key)).sort();
  assert.deepEqual(missing, []);

  const placeholderMisses: string[] = [];
  for (const key of used) {
    const english = en.get(key);
    const chinese = zh.get(key);
    if (!english || !chinese) continue;
    for (const token of english.matchAll(/\{[a-zA-Z0-9_]+\}/g)) {
      const tokenText = token[0];
      if (tokenText !== undefined && !chinese.includes(tokenText)) {
        placeholderMisses.push(`${key} ${tokenText}`);
      }
    }
  }
  assert.deepEqual(placeholderMisses, []);
});
