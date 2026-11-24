import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildIdFiles, computeBuildId } from '../scripts/common/build_id.js';

function tmpScriptsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-buildid-'));
  fs.mkdirSync(path.join(dir, 'common'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deploy_web.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(dir, 'common', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'common', 'b.mjs'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, 'common', 'notes.txt'), 'ignored\n');
  return dir;
}

test('buildIdFiles 只收 deploy_web.js 与 common 下的 js/mjs', () => {
  const dir = tmpScriptsDir();
  const files = buildIdFiles(dir).map(f => path.relative(dir, f));
  assert.deepEqual(files.sort(), ['common/a.js', 'common/b.mjs', 'deploy_web.js']);
});

test('同一份代码两次计算结果相同', () => {
  const dir = tmpScriptsDir();
  assert.equal(computeBuildId(dir), computeBuildId(dir));
});

test('内容变化会改变指纹', () => {
  const dir = tmpScriptsDir();
  const before = computeBuildId(dir);
  fs.writeFileSync(path.join(dir, 'common', 'a.js'), 'export const a = 2;\n');
  assert.notEqual(computeBuildId(dir), before);
});

test('只改 mtime 不改内容，指纹不变', () => {
  const dir = tmpScriptsDir();
  const before = computeBuildId(dir);
  const f = path.join(dir, 'common', 'a.js');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f, future, future);
  assert.equal(computeBuildId(dir), before);
});

test('非 js 文件不影响指纹', () => {
  const dir = tmpScriptsDir();
  const before = computeBuildId(dir);
  fs.writeFileSync(path.join(dir, 'common', 'notes.txt'), 'changed\n');
  assert.equal(computeBuildId(dir), before);
});

test('文件缺失不抛错，指纹仍可计算', () => {
  const dir = tmpScriptsDir();
  const before = computeBuildId(dir);
  fs.rmSync(path.join(dir, 'common', 'b.mjs'));
  const after = computeBuildId(dir);
  assert.match(after, /^[0-9a-f]{10}$/);
  assert.notEqual(after, before);
});

test('common 目录不存在时降级为空集合', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-buildid-empty-'));
  fs.writeFileSync(path.join(dir, 'deploy_web.js'), 'x\n');
  const files = buildIdFiles(dir).map(f => path.relative(dir, f));
  assert.deepEqual(files, ['deploy_web.js']);
  assert.match(computeBuildId(dir), /^[0-9a-f]{10}$/);
});
