import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticPath } from '../server/static.js';

test('根路径映射到 index.html', () => {
  assert.equal(resolveStaticPath('/'), 'index.html');
});

test('允许顶层的 html/js/css', () => {
  assert.equal(resolveStaticPath('/app.js'), 'app.js');
  assert.equal(resolveStaticPath('/style.css'), 'style.css');
});

test('拒绝含路径分隔符的请求', () => {
  assert.equal(resolveStaticPath('/sub/app.js'), null);
});

test('拒绝上级目录穿越', () => {
  assert.equal(resolveStaticPath('/../server/index.js'), null);
  assert.equal(resolveStaticPath('/..%2Fserver'), null);
});

test('拒绝未知扩展名', () => {
  assert.equal(resolveStaticPath('/secret.env'), null);
  assert.equal(resolveStaticPath('/noext'), null);
});

test('拒绝非法的百分号编码', () => {
  assert.equal(resolveStaticPath('/%ZZ.js'), null);
});
