// chat.mjs — BOSS 直聘聊天操作:进入聊天、发消息、发简历
import { CDP, sleep, findPage, openPage } from './cdp.mjs';

// 获取聊天页连接(不存在则新开)
export async function ensureChatPage() {
  let page = await findPage((t) => t.url.includes('web/geek/chat'));
  if (!page) {
    await openPage('https://www.zhipin.com/web/geek/chat');
    await sleep(3500);
    page = await findPage((t) => t.url.includes('web/geek/chat'));
  }
  return CDP.connect(page.webSocketDebuggerUrl);
}

// 选中会话:按关键词(HR 姓名/公司名)在左侧会话列表点击
export async function selectChat(cdp, keyword) {
  const ok = await cdp.evaluate(`(() => {
    const items = document.querySelectorAll('.friend-content');
    for (const it of items) {
      if (it.textContent.includes(${JSON.stringify(keyword)})) {
        it.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!ok) throw new Error(`会话列表中找不到: ${keyword}`);
  await sleep(1800);
  return true;
}

// 获取当前选中会话信息(对方 + 最后消息)
export async function currentChatInfo(cdp) {
  return cdp.evaluate(`(() => {
    const sel = document.querySelector('.friend-content.selected');
    const ci = document.querySelector('#chat-input.chat-input');
    return {
      chat: sel ? sel.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120) : null,
      inputText: ci ? ci.textContent : '',
    };
  })()`);
}

// 在输入框输入文字(触发 Vue 更新,等待按钮激活)
export async function typeMessage(cdp, text) {
  const focused = await cdp.evaluate(`(() => {
    const ci = document.querySelector('#chat-input.chat-input');
    if (!ci) return false;
    ci.focus();
    ci.click();
    return true;
  })()`);
  if (!focused) throw new Error('找不到聊天输入框 #chat-input');
  await sleep(300);

  // 清空输入框残留(上次发送失败可能留下文本,避免重复)
  await cdp.evaluate(`(() => {
    const ci = document.querySelector('#chat-input.chat-input');
    if (ci) { ci.textContent = ''; ci.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(300);

  // 输入:真实键盘事件
  await cdp.send('Input.insertText', { text });

  // 轮询等待发送按钮激活(最多约 3s,按钮状态更新有延迟)
  let ok = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const cur = await cdp.evaluate(`(() => {
      const ci = document.querySelector('#chat-input.chat-input');
      const btn = document.querySelector('.btn-send');
      return { text: ci ? ci.textContent : '', btnDisabled: btn ? /disabled/.test(btn.className) : true };
    })()`);
    if (cur.text === text && !cur.btnDisabled) { ok = true; break; }
  }
  if (!ok) {
    // 兜底:JS 直接设值 + input 事件(实测也能激活按钮)
    await cdp.evaluate(`(() => {
      const ci = document.querySelector('#chat-input.chat-input');
      if (ci) { ci.textContent = ${JSON.stringify(text)}; ci.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await sleep(800);
    const cur = await cdp.evaluate(`(() => {
      const ci = document.querySelector('#chat-input.chat-input');
      const btn = document.querySelector('.btn-send');
      return { text: ci ? ci.textContent : '', btnDisabled: btn ? /disabled/.test(btn.className) : true };
    })()`);
    if (cur.text !== text) throw new Error(`输入内容不符: 期望「${text}」实际「${cur.text}」`);
    if (cur.btnDisabled) throw new Error('发送按钮未激活(输入未被框架识别)');
  }
  return true;
}

// 发送:优先 JS 直接 .click() 发送按钮(实测最可靠);若无效再按 Enter 键兜底
export async function clickSend(cdp) {
  const readLast = `(() => {
    const msgs = Array.from(document.querySelectorAll('.message-item.item-myself'));
    const last = msgs[msgs.length - 1];
    return last ? last.textContent.trim() : '';
  })()`;

  // 方法1:JS 直接点击「发送」按钮(不受鼠标坐标/拦截影响)
  const jsClicked = await cdp.evaluate(`(() => {
    const b = document.querySelector('.btn-send');
    if (!b || /disabled/.test(b.className)) return false;
    b.click();
    return true;
  })()`);
  await sleep(2500);
  let sent = jsClicked ? await cdp.evaluate(readLast) : '';
  if (sent) return sent;

  // 方法2:按 Enter 键
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(2500);
  sent = await cdp.evaluate(readLast);
  return sent;
}

// 发消息:输入 + 发送,返回最终出现在消息区的文本
export async function sendMessage(cdp, text) {
  await typeMessage(cdp, text);
  const sent = await clickSend(cdp);
  if (!sent || !sent.includes(text.slice(0, 15))) {
    throw new Error(`消息未确认发出,最后一条: ${sent}`);
  }
  return sent;
}

// 检查「发简历」按钮是否可用(双方互动后为可用模式;否则是「求简历」unable)
export async function canSendResume(cdp) {
  return cdp.evaluate(`(() => {
    const wraps = Array.from(document.querySelectorAll('.toolbar-btn-content'));
    const w = wraps.find(x => x.textContent.trim().includes('发简历'));
    if (!w) return false;
    const btn = w.querySelector('[class*="toolbar-btn"]');
    return !!(btn && !/unable/.test(btn.className));
  })()`);
}

// 发送附件简历请求:点「发简历」→ 确认面板 → 确定
// 返回 { sent: boolean, detail: string }
export async function sendResumeRequest(cdp) {
  // 1) 点「发简历」按钮
  const box = await cdp.evaluate(`(() => {
    const wraps = Array.from(document.querySelectorAll('.toolbar-btn-content'));
    const w = wraps.find(x => x.textContent.trim().includes('发简历'));
    if (!w) return null;
    const r = w.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) return { sent: false, detail: '找不到「发简历」按钮' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(1200);

  // 2) 确认面板是否出现
  const panel = await cdp.evaluate(`(() => {
    const p = document.querySelector('.panel-resume');
    if (!p || p.offsetParent === null) return null;
    return { text: p.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120) };
  })()`);
  if (!panel) return { sent: false, detail: '确认面板未出现(按钮可能不可用)' };

  // 3) 点「确定」
  const okBox = await cdp.evaluate(`(() => {
    const p = document.querySelector('.panel-resume');
    const btns = p.querySelectorAll('.btn-v2');
    for (const b of btns) {
      if (b.textContent.trim() === '确定') {
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  })()`);
  if (!okBox) return { sent: false, detail: '确认面板无「确定」按钮' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: okBox.x, y: okBox.y });
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: okBox.x, y: okBox.y, button: 'left', clickCount: 1 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: okBox.x, y: okBox.y, button: 'left', clickCount: 1 });
  await sleep(2500);

  // 4) 验证「附件简历请求已发送」
  const sysMsg = await cdp.evaluate(`(() => {
    const msgs = Array.from(document.querySelectorAll('.message-item.item-system'));
    const last = msgs[msgs.length - 1];
    return last ? last.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120) : null;
  })()`);
  if (sysMsg && sysMsg.includes('附件简历请求已发送')) {
    return { sent: true, detail: sysMsg };
  }
  return { sent: false, detail: `未检测到请求发出,最后系统消息: ${sysMsg}` };
}

export { CDP };
