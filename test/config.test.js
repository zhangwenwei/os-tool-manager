import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, buildConfig, loadConfig, getConfig, DEFAULTS } from '../server/config.js';

// 收集拒绝理由，避免测试输出被警告污染
function collector() {
  const rejected = [];
  const fn = (key, value, expectation) => rejected.push({ key, value, expectation });
  return { rejected, fn };
}

test('parseEnv 忽略空行与注释', () => {
  const text = '# comment\n\nPORT=9000\n  LIST_TIMEOUT_MS = 1000  \n';
  assert.deepEqual(parseEnv(text), { PORT: '9000', LIST_TIMEOUT_MS: '1000' });
});

test('parseEnv 保留值中的等号', () => {
  assert.deepEqual(parseEnv('A=b=c'), { A: 'b=c' });
});

test('parseEnv 剥离成对的双引号与单引号', () => {
  assert.deepEqual(parseEnv('A="x"\nB=\'y\''), { A: 'x', B: 'y' });
});

test('parseEnv 不剥离不成对的引号', () => {
  assert.deepEqual(parseEnv('A="x'), { A: '"x' });
});

test('parseEnv 忽略空键', () => {
  assert.deepEqual(parseEnv('=orphan\nA=1'), { A: '1' });
});

test('parseEnv 处理 CRLF 换行', () => {
  assert.deepEqual(parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
});

test('parseEnv 重复键时后者胜出', () => {
  assert.deepEqual(parseEnv('A=1\nA=2'), { A: '2' });
});

test('buildConfig 无输入时全部采用默认值', () => {
  assert.deepEqual(buildConfig(), DEFAULTS);
});

test('buildConfig 返回副本而非 DEFAULTS 本身', () => {
  assert.notStrictEqual(buildConfig(), DEFAULTS);
});

test('DEFAULTS 被冻结，无法篡改', () => {
  assert.throws(() => { DEFAULTS.PORT = 1; }, TypeError);
});

test('buildConfig 部分定义时仅覆盖该项', () => {
  const cfg = buildConfig({ PORT: '9000' });
  assert.equal(cfg.PORT, 9000);
  assert.equal(cfg.LIST_TIMEOUT_MS, DEFAULTS.LIST_TIMEOUT_MS);
});

test('buildConfig 空字符串视为未定义', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected.length, 0);
});

test('buildConfig 非数值时退回默认值并报告', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: 'abc' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected[0].key, 'PORT');
});

test('buildConfig 拒绝负数', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ LIST_TIMEOUT_MS: '-5' }, fn).LIST_TIMEOUT_MS, DEFAULTS.LIST_TIMEOUT_MS);
  assert.equal(rejected[0].key, 'LIST_TIMEOUT_MS');
});

test('buildConfig 拒绝小数', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '80.5' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected.length, 1);
});

test('buildConfig 拒绝十六进制记法', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '0x1E62' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected.length, 1);
});

test('buildConfig 拒绝指数记法', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '1e21' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected.length, 1);
});

test('buildConfig 拒绝超出取值域的端口', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '70000' }, fn).PORT, DEFAULTS.PORT);
  assert.equal(rejected.length, 1);
});

test('buildConfig 接受取值域边界', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ PORT: '1' }, fn).PORT, 1);
  assert.equal(buildConfig({ PORT: '65535' }, fn).PORT, 65535);
  assert.equal(rejected.length, 0);
});

test('buildConfig 布尔项接受多种真值写法', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(buildConfig({ AUTO_OPEN_BROWSER: v }).AUTO_OPEN_BROWSER, true, v);
  }
});

test('buildConfig 布尔项接受多种假值写法', () => {
  for (const v of ['false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(buildConfig({ AUTO_OPEN_BROWSER: v }).AUTO_OPEN_BROWSER, false, v);
  }
});

test('buildConfig 布尔项无效时保留默认值而非翻转', () => {
  const { rejected, fn } = collector();
  assert.equal(buildConfig({ AUTO_OPEN_BROWSER: 'ture' }, fn).AUTO_OPEN_BROWSER, DEFAULTS.AUTO_OPEN_BROWSER);
  assert.equal(rejected[0].key, 'AUTO_OPEN_BROWSER');
});

test('buildConfig 忽略未知键', () => {
  assert.equal(buildConfig({ UNKNOWN: 'x' }).UNKNOWN, undefined);
});

test('loadConfig 读取存在的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otm-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'PORT=9001\n');
  assert.equal(loadConfig(file).PORT, 9001);
});

test('loadConfig 文件不存在时静默采用默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otm-'));
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    assert.deepEqual(loadConfig(join(dir, 'nonexistent')), DEFAULTS);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 0);
});

test('loadConfig 非 ENOENT 错误时警告并采用默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otm-'));
  const asDirectory = join(dir, 'env-dir');
  mkdirSync(asDirectory);
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    assert.deepEqual(loadConfig(asDirectory), DEFAULTS);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EISDIR/);
});

test('getConfig 记忆化，多次调用返回同一对象', () => {
  assert.strictEqual(getConfig(), getConfig());
});

test('清单与操作的输出预算是独立的配置项', () => {
  const cfg = buildConfig({ LIST_MAX_OUTPUT_BYTES: '2048' });
  assert.equal(cfg.LIST_MAX_OUTPUT_BYTES, 2048);
  assert.equal(cfg.ACTION_MAX_OUTPUT_BYTES, DEFAULTS.ACTION_MAX_OUTPUT_BYTES);
});

test('清单的输出预算默认大于操作的输出预算', () => {
  assert.ok(DEFAULTS.LIST_MAX_OUTPUT_BYTES > DEFAULTS.ACTION_MAX_OUTPUT_BYTES);
});
