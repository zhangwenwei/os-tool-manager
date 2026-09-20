import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateToken, checkToken, checkOrigin,
  checkAction, checkItemId, checkConfirm,
} from '../server/security.js';

const req = (headers) => ({ headers });

test('generateToken 产生 64 字符的十六进制串', () => {
  const t = generateToken();
  assert.match(t, /^[0-9a-f]{64}$/);
});

test('generateToken 每次不同', () => {
  assert.notEqual(generateToken(), generateToken());
});

test('checkToken 一致时通过', () => {
  const t = generateToken();
  assert.equal(checkToken(req({ 'x-token': t }), t), null);
});

test('checkToken 缺失时以 401 拒绝（SEC-06）', () => {
  const e = checkToken(req({}), generateToken());
  assert.equal(e.status, 401);
  assert.equal(e.code, 'INVALID_TOKEN');
});

test('checkToken 不一致时以 401 拒绝', () => {
  const e = checkToken(req({ 'x-token': 'a'.repeat(64) }), generateToken());
  assert.equal(e.status, 401);
});

test('checkToken 长度不同时不抛出', () => {
  const e = checkToken(req({ 'x-token': 'short' }), generateToken());
  assert.equal(e.status, 401);
});

test('checkOrigin 一致时通过', () => {
  const o = 'http://127.0.0.1:7788';
  assert.equal(checkOrigin(req({ origin: o }), [o]), null);
});

test('checkOrigin 缺失时以 403 拒绝（SEC-07）', () => {
  const e = checkOrigin(req({}), ['http://127.0.0.1:7788']);
  assert.equal(e.status, 403);
  assert.equal(e.code, 'BAD_ORIGIN');
});

test('checkOrigin 不一致时以 403 拒绝', () => {
  const e = checkOrigin(req({ origin: 'http://evil.example' }), ['http://127.0.0.1:7788']);
  assert.equal(e.status, 403);
});

const adapter = { actions: { update: { destructive: false }, uninstall: { destructive: true } } };

test('checkAction 已声明时通过', () => {
  assert.equal(checkAction(adapter, 'update'), null);
});

test('checkAction 未声明时以 400 拒绝（SEC-08）', () => {
  const e = checkAction(adapter, 'evil');
  assert.equal(e.status, 400);
  assert.equal(e.code, 'UNKNOWN_ACTION');
});

test('checkAction 拒绝原型链上的键', () => {
  const e = checkAction(adapter, 'constructor');
  assert.equal(e.code, 'UNKNOWN_ACTION');
});

test('checkItemId 存在时通过', () => {
  assert.equal(checkItemId(new Map([['ripgrep', {}]]), 'ripgrep'), null);
});

test('checkItemId 不存在时以 409 拒绝（SEC-09）', () => {
  const e = checkItemId(new Map(), 'ripgrep');
  assert.equal(e.status, 409);
  assert.equal(e.code, 'STALE_ITEM');
});

test('checkItemId 清单未取得时以 409 拒绝', () => {
  const e = checkItemId(undefined, 'ripgrep');
  assert.equal(e.status, 409);
});

test('checkConfirm 非破坏性操作无需确认', () => {
  assert.equal(checkConfirm(adapter.actions.update, {}), null);
});

test('checkConfirm 破坏性操作有确认时通过', () => {
  assert.equal(checkConfirm(adapter.actions.uninstall, { confirm: true }), null);
});

test('checkConfirm 破坏性操作缺确认时以 400 拒绝（SEC-10）', () => {
  const e = checkConfirm(adapter.actions.uninstall, {});
  assert.equal(e.status, 400);
  assert.equal(e.code, 'CONFIRM_REQUIRED');
});

test('checkConfirm 确认标记非 true 时拒绝', () => {
  assert.equal(checkConfirm(adapter.actions.uninstall, { confirm: 'yes' }).status, 400);
});

test('checkToken 多字节令牌不抛出而是拒绝', () => {
  const actual = Buffer.alloc(64, 0xc3).toString('latin1');
  assert.equal(checkToken(req({ 'x-token': actual }), generateToken()).status, 401);
});

test('checkAction 适配器未声明 actions 时以 400 拒绝', () => {
  assert.equal(checkAction({}, 'update').status, 400);
});

test('checkAction 适配器为 null 时以 400 拒绝', () => {
  assert.equal(checkAction(null, 'update').status, 400);
});

test('checkOrigin 允许来源未定义时仍拒绝', () => {
  assert.equal(checkOrigin(req({}), []).status, 403);
});

test('checkConfirm 操作为 null 时拒绝', () => {
  assert.equal(checkConfirm(null, { confirm: true }).status, 400);
});

test('checkConfirm 请求体为 null 时拒绝破坏性操作', () => {
  assert.equal(checkConfirm(adapter.actions.uninstall, null).status, 400);
});

test('checkOrigin 允许白名单中的任一来源', () => {
  const allowed = ['http://127.0.0.1:7788', 'http://localhost:7788'];
  assert.equal(checkOrigin(req({ origin: 'http://127.0.0.1:7788' }), allowed), null);
  assert.equal(checkOrigin(req({ origin: 'http://localhost:7788' }), allowed), null);
});

test('checkOrigin 拒绝白名单外的来源', () => {
  const allowed = ['http://127.0.0.1:7788', 'http://localhost:7788'];
  assert.equal(checkOrigin(req({ origin: 'http://evil.example' }), allowed).status, 403);
  assert.equal(checkOrigin(req({ origin: 'http://localhost:9999' }), allowed).status, 403);
});
