// detail-open.mjs — 验证 clickChatButton:打开详情页 → 健壮点击「立即沟通/继续沟通」(临时验证脚本)
import { CDP, openPage, sleep, listTargets } from './cdp.mjs';
import { clickChatButton } from './jobs.mjs';

const URL = 'https://www.zhipin.com/job_detail/e6d94dccbb7826a90nJ52Ni4FFVX.html';

const page = await openPage(URL);
const cdp = await CDP.connect(page.webSocketDebuggerUrl);

// 等页面骨架就绪(不依赖按钮,clickChatButton 内部会等)
await sleep(3000);
console.log('详情页标题:', await cdp.evaluate('document.title').catch(() => 'N/A'));

// 调用健壮点击函数
console.log('调用 clickChatButton …');
const r = await clickChatButton(cdp, { timeoutMs: 25000 });
console.log('结果:', JSON.stringify(r, null, 2));

// 若新开了聊天标签页,连上去确认会话内容
if (r.chatTarget) {
  const chatCdp = await CDP.connect(r.chatTarget.webSocketDebuggerUrl);
  await sleep(2500);
  const st = await chatCdp.evaluate(`(() => {
    const sel = document.querySelector('.friend-content.selected');
    return {
      url: location.href,
      chat: sel ? sel.textContent.trim().replace(/\\s+/g, ' ').slice(0, 80) : null,
      input: !!document.querySelector('#chat-input'),
    };
  })()`);
  console.log('聊天页状态:', JSON.stringify(st, null, 2));
  chatCdp.close();
}

cdp.close();
