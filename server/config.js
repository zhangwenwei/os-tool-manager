import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULTS = Object.freeze({
  PORT: 7788,
  LIST_TIMEOUT_MS: 60000,
  ACTION_TIMEOUT_MS: 600000,
  MAX_OUTPUT_BYTES: 1048576,
  AUTO_OPEN_BROWSER: true,
});

const RANGES = {
  PORT: { min: 1, max: 65535 },
  LIST_TIMEOUT_MS: { min: 1000, max: 86400000 },
  ACTION_TIMEOUT_MS: { min: 1000, max: 86400000 },
  MAX_OUTPUT_BYTES: { min: 1024, max: 1073741824 },
};

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function unquote(value) {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

function warnRejected(key, value, expectation) {
  console.warn(`[config] ${key}="${value}" 无效（${expectation}），采用默认值 ${DEFAULTS[key]}。`);
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    out[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return out;
}

export function buildConfig(raw = {}, onReject = warnRejected) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    const text = String(value);
    if (typeof DEFAULTS[key] === 'number') {
      const { min, max } = RANGES[key];
      const n = /^-?\d+$/.test(text) ? Number(text) : NaN;
      if (n >= min && n <= max) config[key] = n;
      else onReject(key, text, `应为 ${min}～${max} 的整数`);
    } else {
      const lowered = text.toLowerCase();
      if (TRUE_VALUES.has(lowered)) config[key] = true;
      else if (FALSE_VALUES.has(lowered)) config[key] = false;
      else onReject(key, text, '应为 true 或 false');
    }
  }
  return config;
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] 无法读取 ${path}（${err.code ?? err.message}），采用默认值。`);
    }
    return buildConfig();
  }
  return buildConfig(parseEnv(text));
}

let cached = null;

export function getConfig() {
  if (cached === null) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    cached = loadConfig(join(root, '.env'));
  }
  return cached;
}
