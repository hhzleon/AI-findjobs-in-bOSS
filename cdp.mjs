// cdp.mjs — 零依赖 CDP(Chrome DevTools Protocol)客户端
// 基于 Node 22+ 原生 WebSocket + fetch,连接已启动的 Edge/Chrome 调试端口。
import { randomUUID } from 'node:crypto';

const DEBUG_PORT = process.env.CDP_PORT || '9222';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 从调试端口列出所有 target,返回过滤后的列表
export async function listTargets() {
  const res = await fetch(`http://localhost:${DEBUG_PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json 失败: HTTP ${res.status}`);
  return res.json();
}

// 找符合条件的 page target(可传 URL 子串或匹配函数)
export async function findPage(match) {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page');
  const pred = typeof match === 'string' ? (t) => t.url.includes(match) : match;
  return pages.find(pred) || null;
}

// 新建标签页并导航到 url,返回 page target
export async function openPage(url) {
  const res = await fetch(
    `http://localhost:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  );
  if (!res.ok) throw new Error(`CDP 新建标签页失败: HTTP ${res.status}`);
  return res.json();
}

// 关闭一个 target(按调试端口 /json/close),用于投递后回收标签页
export async function closeTarget(targetId) {
  await fetch(`http://localhost:${DEBUG_PORT}/json/close/${targetId}`, { method: 'PUT' }).catch(() => {});
}

// 清理多余页签:保留最多 maxJobs 个岗位页、maxChat 个聊天页,防止 tab 无限增长
export async function tidyTabs({ maxJobs = 1, maxChat = 2 } = {}) {
  try {
    const targets = await listTargets();
    const zp = targets.filter((t) => t.type === 'page' && /zhipin\.com/.test(t.url || ''));
    const jobs = zp.filter((p) => p.url.includes('web/geek/jobs') && !p.url.includes('chat'));
    const chats = zp.filter((p) => p.url.includes('web/geek/chat'));
    const toClose = [...jobs.slice(maxJobs), ...chats.slice(maxChat)];
    for (const p of toClose) await closeTarget(p.id);
    return toClose.length;
  } catch { return 0; }
}

// 检测当前页面是否出现验证码/滑块(防风控)。返回命中的选择器或 null。
export async function detectCaptcha(cdp) {
  return cdp.evaluate(`(() => {
    const selectors = [
      '.captcha-dialog', '.captcha-panel', '#captcha-dialog',
      '.yidun_panel', '.yidun-panel', '.yidun', '.tc-action',
      '.slider-captcha', '[class*="captcha"]', '[class*="yidun"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return s;
    }
    return null;
  })()`);
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.pending = new Map(); // id -> {resolve, reject}
    this.listeners = new Map(); // event -> [fn]
    this.nextId = 1;
  }

  static async connect(wsUrl) {
    const c = new CDP(wsUrl);
    await c._open();
    return c;
  }

  static async connectPage(match) {
    const page = await findPage(match);
    if (!page) throw new Error(`找不到匹配的 page target: ${match}`);
    return CDP.connect(page.webSocketDebuggerUrl);
  }

  _open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`WebSocket 连接失败: ${e.message || e}`));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          const fns = this.listeners.get(msg.method) || [];
          for (const fn of fns) fn(msg.params);
        }
      };
    });
  }

  // 发送 CDP 命令,返回 result(带默认超时,防止渲染进程卡死导致永久挂起)
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 订阅事件
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  // 在页面执行 JS,返回返回值(awaitPromise)
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `页面 JS 异常: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || '')}`
      );
    }
    return r.result?.value;
  }

  async navigate(url, opts = {}) {
    const { waitUntil = 'load', timeoutMs = 30000 } = opts;
    const done = new Promise((resolve) => {
      this.on('Page.loadEventFired', resolve);
    });
    await this.send('Page.navigate', { url });
    if (waitUntil === 'load') {
      await Promise.race([done, sleep(timeoutMs)]);
    }
    await sleep(1000); // 给 SPA 一点渲染时间
  }

  // 等待某 JS 条件为真
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return true;
      await sleep(intervalMs);
    }
    throw new Error(`waitFor 超时(${timeoutMs}ms): ${expression}`);
  }

  // 在当前页面执行点击(通过 JS 触发,返回是否成功)
  async click(selector, { timeoutMs = 10000 } = {}) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
  }

  // 坐标级真实鼠标点击(触发完整 mouseMoved/mousedown/mouseup/click 事件链,
  // 兼容 Vue/React 的合成事件绑定,比 JS .click() 更可靠)
  // 返回是否成功(坐标在视口内且页面有响应)
  async realClickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(100);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  // 按选择器做真实点击:先滚动到可见,再取中心坐标点击
  // 元素不存在或不可见返回 false
  async realClick(selector, { scroll = true, retries = 1 } = {}) {
    for (let i = 0; i <= retries; i++) {
      const box = await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        if (${scroll}) el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (box) return this.realClickAt(box.x, box.y);
      if (i < retries) await sleep(600);
    }
    return false;
  }

  // 设置输入框的值并派发 input 事件(兼容 Vue/React)
  async setInput(selector, value) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  // 截取当前页面截图,保存到文件
  async screenshot(filePath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export { sleep };
