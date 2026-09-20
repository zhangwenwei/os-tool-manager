const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
if (params.has('token')) {
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
}

const statusEl = document.getElementById('status');
const cardsEl = document.getElementById('cards');
const confirmDialog = document.getElementById('confirm-dialog');
const confirmText = document.getElementById('confirm-text');
const outputDialog = document.getElementById('output-dialog');
const outputTitle = document.getElementById('output-title');
const outputBody = document.getElementById('output-body');

class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail ?? null;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'x-token': token, 'content-type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    throw new ApiError('访问令牌无效。服务重启后令牌会变更，请用终端中打印的新 URL 重新打开本页面。', null);
  }
  if (!res.ok) {
    throw new ApiError(data?.error?.message ?? `HTTP ${res.status}`, data?.error?.detail);
  }
  return data;
}

function showOutput(title, parts) {
  outputTitle.textContent = title;
  const text = parts.filter((p) => p && p.trim()).join('\n\n');
  outputBody.textContent = text || '（无输出）';
  outputDialog.showModal();
}

function askConfirm(text) {
  confirmText.textContent = text;
  confirmDialog.returnValue = 'cancel';
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

const STATUS_LABEL = { ok: '最新', outdated: '有更新', unknown: '未知' };

class Card {
  constructor(adapter) {
    this.adapter = adapter;
    this.items = null;
    this.el = document.createElement('section');
    this.el.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('h2');
    title.textContent = adapter.label;
    this.countEl = document.createElement('span');
    this.countEl.className = 'count';
    this.refreshBtn = document.createElement('button');
    this.refreshBtn.textContent = '刷新';
    this.refreshBtn.addEventListener('click', () => this.load());
    head.append(title, this.countEl, this.refreshBtn);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'card-body';
    this.el.append(head, this.bodyEl);
  }

  message(text, className = 'msg') {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  }

  async load() {
    this.setBusy(true);
    this.countEl.textContent = '取得中…';
    if (this.items === null) {
      this.bodyEl.replaceChildren(this.message('取得中…'));
    }
    try {
      const { items } = await api(`/api/adapters/${encodeURIComponent(this.adapter.id)}/items`);
      this.items = items;
      this.render();
    } catch (e) {
      this.countEl.textContent = '取得失败';
      const retry = document.createElement('button');
      retry.className = 'retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => this.load());
      this.bodyEl.replaceChildren(
        this.message([e.message, e.detail].filter(Boolean).join('\n\n'), 'msg error'),
        retry
      );
      this.items = null;
    } finally {
      this.setBusy(false);
    }
  }

  render() {
    const outdated = this.items.filter((i) => i.status === 'outdated').length;
    this.countEl.textContent = `${this.items.length} 件${outdated ? ` · ${outdated} 件有更新` : ''}`;
    if (this.items.length === 0) {
      this.bodyEl.replaceChildren(this.message('无条目。'));
      return;
    }
    this.bodyEl.replaceChildren(...this.items.map((item) => this.renderRow(item)));
  }

  renderRow(item) {
    const row = document.createElement('div');
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    if (item.active === true) {
      const tag = document.createElement('span');
      tag.className = 'active-tag';
      tag.textContent = '当前生效';
      name.append(tag);
    }

    const ver = document.createElement('span');
    ver.className = 'ver';
    if (item.status === 'outdated') ver.textContent = `${item.current} → ${item.latest}`;
    else if (item.status === 'unknown') ver.textContent = `${item.current ?? '—'} → 未知`;
    else ver.textContent = item.current;

    const badge = document.createElement('span');
    badge.className = `badge ${item.status}`;
    badge.textContent = STATUS_LABEL[item.status] ?? item.status;

    row.append(name, ver, badge);

    for (const key of item.actions) {
      const meta = this.adapter.actions?.[key];
      if (!meta) continue;
      const btn = document.createElement('button');
      btn.textContent = meta.label;
      if (meta.destructive) btn.classList.add('danger');
      btn.addEventListener('click', () => this.runAction(item, key, meta, row));
      row.append(btn);
    }
    return row;
  }

  setBusy(busy) {
    for (const b of this.el.querySelectorAll('button')) b.disabled = busy;
  }

  async runAction(item, key, meta, row) {
    if (meta.destructive) {
      const agreed = await askConfirm(`确定要对「${item.name}」执行${meta.label}吗？此操作不可撤销。`);
      if (!agreed) return;
    }
    this.setBusy(true);
    row.classList.add('busy');
    this.countEl.textContent = `${meta.label}执行中…`;
    try {
      const body = { itemId: item.id };
      if (meta.destructive) body.confirm = true;
      const result = await api(
        `/api/adapters/${encodeURIComponent(this.adapter.id)}/actions/${encodeURIComponent(key)}`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!result.ok) {
        const head = `退出码 ${result.exitCode ?? '—'}`
          + (result.signal ? ` / 信号 ${result.signal}` : '')
          + (result.truncated ? '（输出已截断）' : '');
        showOutput(`${item.name} 的${meta.label}失败`, [head, result.stdout, result.stderr]);
      }
    } catch (e) {
      showOutput(`${item.name} 的${meta.label}失败`, [e.message, e.detail]);
    } finally {
      row.classList.remove('busy');
    }
    await this.load();
  }
}

async function main() {
  if (!token) {
    statusEl.textContent = '缺少访问令牌。请使用服务启动时打印的完整 URL 打开本页面。';
    return;
  }
  try {
    const { adapters } = await api('/api/adapters');
    if (adapters.length === 0) {
      statusEl.textContent = '本机未检测到可管理的生态。';
      return;
    }
    statusEl.textContent = `${adapters.length} 个生态可用`;
    const cards = adapters.map((a) => new Card(a));
    cardsEl.replaceChildren(...cards.map((c) => c.el));
    await Promise.all(cards.map((c) => c.load()));
  } catch (e) {
    statusEl.textContent = `初始化失败：${e.message}`;
  }
}

main();
