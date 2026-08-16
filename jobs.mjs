// jobs.mjs — BOSS 直聘岗位列表与进入聊天
import { CDP, sleep, findPage, openPage, listTargets } from './cdp.mjs';

const JOBS_PAGE = 'https://www.zhipin.com/web/geek/jobs';

// 拼接搜索页 URL(按关键词 + 城市)
export function buildSearchUrl(keyword, city = '101280600') {
  return keyword
    ? `${JOBS_PAGE}?query=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}`
    : JOBS_PAGE;
}

// 获取岗位列表页连接(keyword 为空则复用/打开默认列表页;有则确保处于该关键词的搜索结果)
export async function ensureJobsPage(keyword, city = '101280600') {
  const isChat = (t) => t.url.includes('web/geek/jobs') && !t.url.includes('chat');
  let page = await findPage(isChat);
  if (!page) {
    await openPage(buildSearchUrl(keyword, city));
    await sleep(4000);
    page = await findPage(isChat);
    if (!page) throw new Error('打开岗位列表页失败');
  }
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  // 若需按关键词定位且当前页关键词不符,则导航过去
  if (keyword && !page.url.includes(`query=${encodeURIComponent(keyword)}`)) {
    await cdp.navigate(buildSearchUrl(keyword, city));
    await sleep(2000);
  }
  // 等待岗位列表加载
  await cdp.waitFor(`document.querySelectorAll('.job-card-box').length > 0`, { timeoutMs: 20000 })
    .catch(() => {});
  return cdp;
}

// 在当前列表页按 jobId 找到卡片索引(找不到返回 -1)
export async function findJobIndexByHref(cdp, jobLink) {
  const idx = await cdp.evaluate(`(() => {
    const cards = document.querySelectorAll('.job-card-box');
    const target = ${JSON.stringify(jobLink || '')};
    const jobId = target.split('/').pop().replace('.html', '');
    for (let i = 0; i < cards.length; i++) {
      const a = cards[i].querySelector('.job-name');
      const href = a ? (a.getAttribute('href') || '') : '';
      if (jobId && href.includes(jobId)) return i;
    }
    return -1;
  })()`);
  return idx;
}

// 从当前岗位列表页提取岗位数据(不跳转,直接从 DOM 读取)
export async function fetchJobList(cdp) {
  return cdp.evaluate(`(() => {
    const cards = document.querySelectorAll('.job-card-box');
    return Array.from(cards).map((card) => {
      const nameEl = card.querySelector('.job-name');
      const href = nameEl ? nameEl.getAttribute('href') : '';
      const m = href.match(/job_detail\\/([^\\/]+)\\.html/);
      const areaEl = card.querySelector('.job-area, .company-location');
      return {
        jobId: m ? m[1] : null,
        title: nameEl ? nameEl.textContent.trim() : '',
        salary: (card.querySelector('.job-salary')?.textContent || '').trim(),
        tags: Array.from(card.querySelectorAll('.tag-list li')).map((e) => e.textContent.trim()),
        company: (card.querySelector('.boss-name')?.textContent || '').trim(),
        location: (areaEl?.textContent || '').trim(),
        href: href,
      };
    });
  })()`);
}

// 点击第 index 个岗位卡片(0 起),右侧会打开职位详情面板
export async function openJobCard(cdp, index) {
  const ok = await cdp.evaluate(`(() => {
    const cards = document.querySelectorAll('.job-card-box');
    const i = ${JSON.stringify(index)};
    if (i < 0 || i >= cards.length) return false;
    const el = cards[i];
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`岗位卡片索引越界: ${index}`);
  await sleep(1500);
  return true;
}

// 打招呼并进入聊天。
// 两种路径:
//   默认招呼「开启」:点「立即沟通」→ 自动发默认招呼 → 弹「已向BOSS发送消息」→ 点「继续沟通」→ 跳转聊天页
//   默认招呼「关闭」(用户在平台关闭):点「立即沟通」→ 直接跳转聊天页,无弹窗(本系统随后手动发送问候语)
// 返回 { greeted: boolean, entered: boolean, detail: string }
export async function greetAndEnterChat(cdp) {
  // 若已在聊天页则直接返回
  const url = await cdp.evaluate('location.href');
  if (url.includes('/web/geek/chat')) return { greeted: true, entered: true, detail: '已在聊天页' };

  // 点「立即沟通」(或已打过招呼时点「继续沟通」)
  const clicked = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.op-btn-chat, button, a'));
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '立即沟通' && !/disabled/.test(b.className)) { b.click(); return 'greet'; }
    }
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '继续沟通') { b.click(); return 'continue'; }
    }
    return 'none';
  })()`);

  if (clicked === 'none') {
    // 可能是「已沟通」(disabled) 或其他状态,读取按钮文案区分
    const btnText = await cdp.evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('.op-btn-chat, button, a'));
      const b = btns.find((x) => /立即沟通|继续沟通|已沟通|已投递|已下载/.test(x.textContent || ''));
      return b ? b.textContent.trim().replace(/\\s+/g, ' ') : '';
    })()`);
    if (/已沟通|已投递|已下载/.test(btnText)) {
      return { greeted: true, entered: false, button: btnText, detail: '该岗位已沟通过,无需重复打招呼' };
    }
    return { greeted: false, entered: false, button: btnText || 'none', detail: `未找到「立即沟通/继续沟通」按钮(当前: ${btnText || '无'})` };
  }

  // 先等跳转聊天页(默认招呼关闭时点「立即沟通」会直接跳转,无弹窗)
  const navigated = await cdp.waitFor(`location.href.includes('/web/geek/chat')`, { timeoutMs: 12000 }).catch(() => false);
  if (navigated) {
    await sleep(2000);
    return { greeted: clicked === 'greet', entered: true, detail: '已进入聊天页(无默认招呼,需手动发问候语)' };
  }

  // 未直接跳转:默认招呼开启时会有「已向BOSS发送消息」弹窗,点「继续沟通」
  const waited = await cdp.waitFor(`(() => {
    const btns = Array.from(document.querySelectorAll('.default-btn, .sure-btn, a, button'));
    return btns.some((b) => {
      const t = (b.textContent || '').trim();
      if (t !== '继续沟通') return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  })()`, { timeoutMs: 8000 }).catch(() => false);
  if (!waited) return { greeted: clicked === 'greet', entered: false, detail: '既未跳转聊天页,也未出现「继续沟通」弹窗' };

  const entered = await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.default-btn, .sure-btn, a, button'));
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '继续沟通') {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { b.click(); return true; }
      }
    }
    return false;
  })()`);
  if (!entered) return { greeted: clicked === 'greet', entered: false, detail: '「继续沟通」弹窗未出现' };

  const ok = await cdp.waitFor(`location.href.includes('/web/geek/chat')`, { timeoutMs: 15000 });
  if (!ok) return { greeted: clicked === 'greet', entered: false, detail: '未跳转到聊天页' };
  await sleep(2000);
  return { greeted: clicked === 'greet', entered: true, detail: '已进入聊天页' };
}

export { CDP };

// ============ 详情页/岗位面板「立即沟通/继续沟通」按钮的健壮打开 ============
// 逆向结论(2026-08-16 SEO 详情页实测):
//   - 按钮 = <a class="btn btn-startchat" data-url="add.json" redirect-url="聊天URL" data-isfriend="true|false">
//   - data-isfriend="true" →「继续沟通」:点击即整页导航到 /web/geek/chat(不再调 add.json)
//   - data-isfriend="false"→「立即沟通」:点击 = 页面主世界 fetch(add.json) 加好友 → 导航到 /web/geek/chat
//   - 历史「点不动/弹完善简历」= BOSS 在线简历未完善时前置弹窗;完善后真实坐标点击即生效
// 稳健策略:
//   1. 轮询等待按钮 + 读取 data-isfriend / data-url / redirect-url
//   2. 真实坐标点击(触发完整事件链)
//   3. 等待生效:同页跳聊天页 / 弹「已向BOSS发送消息」确认框 / 新开聊天 tab
//   4. 识别阻断弹窗(登录 / 完善简历)→ 返回 blocked,让调度层干净停止
//   5. 点击 ~8s 无效果且为「立即沟通」→ 主世界直接调 add.json 兜底(绕开 DOM/遮罩)
//
// 返回: { clicked, entered, newTab, greeted, button, detail, blocked, modal, chatTarget }
//   - blocked: null | 'login' | 'resume'(被何种弹窗阻断);modal: 弹窗文本
//   - chatTarget: 新开聊天标签页时的 page target(含 webSocketDebuggerUrl),否则 null
//   - onNewTab(可选回调): 检测到新标签页时调用(用于外部接管新页面)
export async function clickChatButton(cdp, { timeoutMs = 25000, intervalMs = 600, onNewTab } = {}) {
  const beforeTargets = await listTargets();
  const startedUrl = await cdp.evaluate('location.href');
  const steps = [];

  // ---- 1) 等待按钮出现并识别状态 ----
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await probeChatButton(cdp);
    if (state.found) break;
    await sleep(intervalMs);
  }
  if (!state || !state.found) {
    return { clicked: false, entered: false, newTab: false, button: null, detail: `等待超时(${timeoutMs}ms): 未找到「立即沟通/继续沟通」按钮`, blocked: null, modal: null };
  }

  // 已沟通/已投递(disabled):不误点,直接返回状态
  if (state.done) {
    return { clicked: false, entered: false, newTab: false, button: state.button, detail: `按钮状态「${state.button}」,该岗位已处理过,无需重复操作`, blocked: null, modal: null, isfriend: state.isfriend, dataUrl: state.dataUrl, redirectUrl: state.redirectUrl };
  }

  // ---- 2) 坐标级真实点击 ----
  await cdp.realClickAt(state.box.x, state.box.y);
  const clickedBtn = state.button;
  const clickTime = Date.now();
  steps.push(`点击「${clickedBtn}」@(${state.box.x},${state.box.y})`);

  // ---- 3) 等待生效(跳转 / 弹窗 / 新标签页),同时识别阻断弹窗 ----
  const waitDeadline = Date.now() + timeoutMs;
  let fallbackTried = false;
  while (Date.now() < waitDeadline) {
    // 3a. 阻断弹窗(登录 / 完善简历)→ 干净返回,调度层停止
    const blocked = await detectBlockingModal(cdp);
    if (blocked) {
      return { clicked: true, entered: false, newTab: false, greeted: clickedBtn === '立即沟通', button: clickedBtn, detail: `被「${blocked.text}」弹窗挡住,需人工处理`, blocked: blocked.kind, modal: blocked.text, steps };
    }

    // 3b. 同页跳转聊天页
    const url = await cdp.evaluate('location.href');
    if (url.includes('/web/geek/chat') && url !== startedUrl) {
      await sleep(2000);
      return { clicked: true, entered: true, newTab: false, greeted: clickedBtn === '立即沟通', button: clickedBtn, detail: `已进入聊天页: ${url.slice(0, 80)}`, chatTarget: null, blocked: null, modal: null, steps };
    }

    // 3c. 弹出「继续沟通」确认框 → 点击
    const modalClicked = await cdp.evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('.default-btn, .sure-btn, a, button'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (t !== '继续沟通') continue;
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          b.scrollIntoView({ block: 'center' });
          const c = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          b.click(); // 弹窗内按钮 JS 事件可靠
          return c;
        }
      }
      return null;
    })()`);
    if (modalClicked) {
      steps.push('弹「已向BOSS发送消息」→ 点继续沟通');
      await sleep(2000);
      const url2 = await cdp.evaluate('location.href');
      if (url2.includes('/web/geek/chat')) {
        return { clicked: true, entered: true, newTab: false, greeted: clickedBtn === '立即沟通', button: clickedBtn, detail: '已点「继续沟通」并进入聊天页', chatTarget: null, blocked: null, modal: null, steps };
      }
    }

    // 3d. 新开聊天标签页
    const nowTargets = await listTargets();
    const newTab = nowTargets.find(
      (t) => t.type === 'page' && /zhipin\.com\/web\/geek\/chat/.test(t.url || '') && !beforeTargets.some((b) => b.id === t.id)
    );
    if (newTab) {
      if (typeof onNewTab === 'function') onNewTab(newTab);
      return { clicked: true, entered: true, newTab: true, greeted: clickedBtn === '立即沟通', button: clickedBtn, detail: `已点击「${clickedBtn}」,新开聊天标签页`, chatTarget: newTab, blocked: null, modal: null, steps };
    }

    // 3e. 点击 ~8s 仍无任何效果 → 兜底
    //   继续沟通(已是好友):按钮本身就是直达 /web/geek/chat,兜底同款直达
    //   立即沟通(新好友):主世界直接调 add.json 加好友,再进聊天页
    if (!fallbackTried && Date.now() - clickTime > 8000) {
      fallbackTried = true;
      if (state.isfriend === true) {
        await cdp.navigate('https://www.zhipin.com/web/geek/chat', { waitUntil: 'load', timeoutMs: 20000 }).catch(() => {});
        await sleep(1500);
        const url3 = await cdp.evaluate('location.href');
        if (url3.includes('/web/geek/chat')) {
          return { clicked: false, entered: true, newTab: false, greeted: false, button: clickedBtn, detail: '「继续沟通」点击无响应,兜底直达聊天页', chatTarget: null, blocked: null, modal: null, steps };
        }
        return { clicked: false, entered: false, newTab: false, greeted: false, button: clickedBtn, detail: '兜底直达聊天页未确认', blocked: null, modal: null, steps };
      } else if (state.dataUrl) {
        const fb = await directAddFriend(cdp, state);
        steps.push(fb.detail);
        if (fb.ok) {
          await cdp.navigate('https://www.zhipin.com/web/geek/chat', { waitUntil: 'load', timeoutMs: 20000 }).catch(() => {});
          await sleep(1500);
          const url3 = await cdp.evaluate('location.href');
          if (url3.includes('/web/geek/chat')) {
            return { clicked: false, entered: true, newTab: false, greeted: true, button: clickedBtn, detail: `兜底 add.json(${fb.method})成功并进入聊天页`, chatTarget: null, blocked: null, modal: null, steps };
          }
          return { clicked: false, entered: false, newTab: false, greeted: true, button: clickedBtn, detail: `兜底 add.json(${fb.method})成功,但聊天页跳转未确认`, blocked: null, modal: null, steps };
        }
      }
    }

    await sleep(intervalMs);
  }

  return { clicked: true, entered: false, newTab: false, button: clickedBtn, detail: '已点击按钮,但未检测到进入聊天(可能网络慢或需人工确认)', chatTarget: null, blocked: null, modal: null, steps };
}

// 在页面内探测「立即沟通/继续沟通」按钮
// 返回 { found, button, done, box, isfriend, dataUrl, redirectUrl }:
//   found=false 未出现;done=true 为已沟通/已投递(disabled);box 为可点击坐标
//   isfriend = data-isfriend 是否为 'true'(true→继续沟通,false→立即沟通)
//   dataUrl/redirectUrl 供 add.json 兜底与直达聊天页使用
export function probeChatButton(cdp) {
  return cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.op-btn-chat, button, a'));
    const cand = btns.filter((b) => /立即沟通|继续沟通|已沟通|已投递|已下载/.test((b.textContent || '').trim()));
    const mk = (b, t, r) => ({
      found: true, button: t, done: false,
      isfriend: b.getAttribute('data-isfriend') === 'true',
      dataUrl: b.getAttribute('data-url') || '',
      redirectUrl: b.getAttribute('redirect-url') || '',
      box: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
    });

    // 1) 可见且可用的「立即沟通」/「继续沟通」
    for (const b of cand) {
      const t = (b.textContent || '').trim();
      if (t !== '立即沟通' && t !== '继续沟通') continue;
      if (/disabled/.test(b.className || '')) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return mk(b, t, r);
    }
    // 2) disabled 的「已沟通/已投递/已下载」→ 已处理过
    for (const b of cand) {
      const t = (b.textContent || '').trim();
      if (/已沟通|已投递|已下载/.test(t)) return { found: true, button: t, done: true };
    }
    // 3) 存在但不可见(可能需滚动/懒加载)→ 滚动后再取坐标
    for (const b of cand) {
      const t = (b.textContent || '').trim();
      if (t !== '立即沟通' && t !== '继续沟通') continue;
      if (/disabled/.test(b.className || '')) continue;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return mk(b, t, r);
    }
    return { found: false };
  })()`);
}

// 识别阻断性弹窗:登录 / 完善简历(只匹配可见的弹窗容器,避免误报页面正文)
// 返回 { kind: 'login'|'resume', text } | null
function detectBlockingModal(cdp) {
  return cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.dialog, .modal, .el-dialog, [class*="modal"], [class*="dialog"], [class*="layer"], [class*="verify"], [class*="passport"]'))
      .find((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 50 && r.height > 50 && m.offsetParent !== null && getComputedStyle(m).visibility !== 'hidden';
      });
    if (!modal) return null;
    const t = (modal.textContent || '').replace(/\s+/g, ' ');
    if (/完善简历|完善在线简历|填写在线简历|简历完整度/.test(t)) return { kind: 'resume', text: t.slice(0, 60) };
    if (/登录|扫码登录|账号密码|验证码登录|手机号登录/.test(t)) return { kind: 'login', text: t.slice(0, 60) };
    return null;
  })()`);
}

// 兜底:页面主世界直接调 add.json(与页面自身请求同源同 cookie),方法无关 GET→POST
// 仅当前面真实点击无任何效果时使用;成功即加好友(打招呼),失败无副作用
async function directAddFriend(cdp, state) {
  const addUrl = state.dataUrl;
  if (!addUrl) return { ok: false, detail: '无 data-url,无法兜底 add.json' };
  const expr = `(async () => {
    try {
      for (const m of ['GET', 'POST']) {
        const r = await fetch(${JSON.stringify(addUrl)}, { method: m, credentials: 'include' });
        let j = null;
        try { j = await r.json(); } catch (e) {}
        const code = j ? j.code : null;
        if (code === 0) return { ok: true, method: m, code };
      }
      return { ok: false, why: 'no-success' };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  })()`;
  let res = null;
  try { res = await cdp.evaluate(expr); } catch (e) { return { ok: false, detail: `兜底 add.json 执行异常: ${e.message}` }; }
  return res && res.ok
    ? { ok: true, method: res.method, detail: `兜底 add.json(${res.method}) 成功` }
    : { ok: false, detail: `兜底 add.json 失败: ${JSON.stringify(res)}` };
}
