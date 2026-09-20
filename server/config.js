import { readFileSync } from 'node:fs';

export const DEFAULTS = {
  PORT: 7788,
  LIST_TIMEOUT_MS: 60000,
  ACTION_TIMEOUT_MS: 600000,
  MAX_OUTPUT_BYTES: 1048576,
  AUTO_OPEN_BROWSER: true,
};

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function buildConfig(raw = {}) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === '') continue;
    if (typeof DEFAULTS[key] === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) config[key] = n;
    } else {
      config[key] = value === 'true';
    }
  }
  return config;
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return buildConfig();
  }
  return buildConfig(parseEnv(text));
}
