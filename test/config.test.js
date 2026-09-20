import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, buildConfig, DEFAULTS } from '../server/config.js';

test('parseEnv 忽略空行与注释', () => {
  const text = '# comment\n\nPORT=9000\n  LIST_TIMEOUT_MS = 1000  \n';
  assert.deepEqual(parseEnv(text), { PORT: '9000', LIST_TIMEOUT_MS: '1000' });
});

test('parseEnv 保留值中的等号', () => {
  assert.deepEqual(parseEnv('A=b=c'), { A: 'b=c' });
});

test('buildConfig 无输入时全部采用默认值', () => {
  assert.deepEqual(buildConfig(), DEFAULTS);
});

test('buildConfig 部分定义时仅覆盖该项', () => {
  const cfg = buildConfig({ PORT: '9000' });
  assert.equal(cfg.PORT, 9000);
  assert.equal(cfg.LIST_TIMEOUT_MS, DEFAULTS.LIST_TIMEOUT_MS);
});

test('buildConfig 数值项非数值时退回默认值', () => {
  assert.equal(buildConfig({ PORT: 'abc' }).PORT, DEFAULTS.PORT);
});

test('buildConfig 空字符串视为未定义', () => {
  assert.equal(buildConfig({ PORT: '' }).PORT, DEFAULTS.PORT);
});

test('buildConfig 布尔项仅 "true" 为真', () => {
  assert.equal(buildConfig({ AUTO_OPEN_BROWSER: 'false' }).AUTO_OPEN_BROWSER, false);
  assert.equal(buildConfig({ AUTO_OPEN_BROWSER: 'true' }).AUTO_OPEN_BROWSER, true);
});

test('buildConfig 忽略未知键', () => {
  assert.equal(buildConfig({ UNKNOWN: 'x' }).UNKNOWN, undefined);
});
