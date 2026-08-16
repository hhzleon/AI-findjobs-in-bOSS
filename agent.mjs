// agent.mjs — AI 对话代理:监听聊天会话新回复 → LLM 生成回复/发简历/标记不合适
// 用法:
//   node agent.mjs once          # 跑一轮扫描(有 LLM key 用 LLM,否则关键词兜底)
//   node agent.mjs loop          # 持续监听(默认每 90s 一轮,含静默时段与限频)
//   node agent.mjs once --mock   # 强制用关键词规则(不调 LLM,便于测试)
//
// 行为:
//   - 首次扫描(会话无记录)只登记监听状态,不回复 —— 避免对历史会话轰炸
//   - 之后发现新的 HR 回复 → LLM 判定动作:
//       reply         生成回复并发送(基于简历画像,不编造)
//       send_resume   HR 要简历 → 自动发简历请求
//       mark_rejected HR 说不合适/已招满 → 标记 reject 并停止投入
//       no_action     无需回复
//   - 安全护栏:不暴露是AI / 只基于画像事实 / 限频延迟 / 夜间静默 / 验证码即停
import { CDP, sleep, detectCaptcha, findPage, openPage } from './cdp.mjs';
import { sendMessage, sendResumeRequest, canSendResume } from './chat.mjs';
import { loadConfig, loadResumeProfile } from './config.mjs';
import { openDb, closeDb, getDb, upsertAiSession, getAiSession, getJob, updateApplied } from './storage.mjs';

const CHAT_PAGE = 'https://www.zhipin.com/web/geek/chat';
const isChatPage = (t) => t.url.includes('web/geek/chat');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    cmd: args.find((a) => a === 'once' || a === 'loop') || 'once',
    mock: args.includes('--mock'),
  };
}

// ---------- 通用 LLM JSON 调用 ----------
async function llmJson(baseUrl, apiKey, model, sys, user) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.3,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30000), // LLM 超时 30s,防止挂起
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 未返回 JSON');
  return JSON.parse(m[0]);
}

// ---------- 决策 ----------
function buildPrompt(ctx, profile, agentCfg) {
  const job = ctx.job;
  const jobInfo = job
    ? `岗位:${job.title || ''} | 薪资:${job.salary || ''} | 公司:${job.company || ''} | 地点:${job.location || ''}\nJD:${(job.jd || '').slice(0, 800)}`
    : '(该会话未关联到岗位库)';
  const transcript = ctx.transcript.map((m) => `${m.dir === 'me' ? '我' : m.dir === 'other' ? '对方(HR)' : '系统'}[${m.time}]: ${m.text}`).join('\n');
  return `
# 求职者画像(只可依据这些事实,不可编造)
${JSON.stringify(profile, null, 2)}

${jobInfo}

# 当前对话记录(最新在最下)
${transcript}

# 你的任务
分析对方(HR)最新消息,决定下一步动作。只输出 JSON:
{
  "action": "reply" | "send_resume" | "mark_rejected" | "interview" | "closed" | "no_action",
  "reply": "reply/interview/closed 时给你的回复内容(1-3 句,自然口语化,中文)",
  "reason": "一句判断理由",
  "reject_reason": "mark_rejected 时填写原因(如:HR明确说不合适/已招满/薪资差距过大/要求不符)"
}

判定规则:
- reply:   对方提出了问题或需要回应(如问经验/技能/到岗时间/期望,或对方报了岗位细节需要表态)
- send_resume: 对方明确要简历(如「发份简历看看」「把简历发我」)
- mark_rejected: 对方明确表示不合适/不考虑/已招满/不匹配/婉拒,或要求与画像严重不符(如要求经验年限冲突、明确排斥你的方向)
- interview: 对方邀约面试/发面试邀请/让加微信聊面试(如「明天来面试」「约个时间面聊」「加个微信」)→ 给一个确认回复
- closed: 对方道谢/告别/明确结束对话(如「谢谢，再见」「好的，就到这里」)→ 可回一句客气话收尾(或不回)
- no_action: 寒暄、无需回应、或只是系统消息

铁律:
- 绝不暴露自己是 AI/机器人/自动化
- 只基于画像中的真实经历技能回答,不编造、不夸大
- 涉及期望薪资:只能引用画像里的 expected_salary 字段;若为空则答「可以面谈」,绝不自己报数字
- 不承诺到岗/加班/出差等画像外内容
- 语气自然专业、简短得体,像真人求职者
`.trim();
}

// LLM 决策(需 key)
export async function llmDecide(ctx, profile, cfg) {
  const llm = cfg.llm;
  const sys = cfg.agent.persona + `\n铁律:绝不暴露自己是AI;只依据画像事实回答;不承诺画像外内容;回复自然简短。`;
  return await llmJson(llm.base_url, llm.api_key, llm.model, sys, buildPrompt(ctx, profile, cfg));
}

// 关键词兜底决策(无 key / --mock),用于测试与降级
export function keywordDecide(ctx) {
  const others = ctx.transcript.filter((m) => m.dir === 'other');
  const last = others[others.length - 1];
  const t = last?.text || '';
  if (/不合适|不匹配|已招满|招满了|不考虑|不符合|婉拒|感谢.*关注|抱歉|pass|暂不需要|不需要/.test(t)) {
    return { action: 'mark_rejected', reject_reason: 'HR 明确表示不合适/已招满', reply: '' };
  }
  if (/简历|发份|发下.*简历|看看.*简历|投递.*简历/.test(t)) {
    return { action: 'send_resume', reply: '' };
  }
  if (/期望薪资|薪资要求|期望待遇|工资|待遇如何|期望.*薪/.test(t)) {
    return { action: 'reply', reply: '您好,期望薪资在 20K 左右,具体可以面谈。', reason: '对方询问期望薪资' };
  }
  if (/在深圳|哪里|城市|base|地点|工作地点/.test(t)) {
    return { action: 'reply', reply: '在深圳,可以配合线下面试。', reason: '对方询问所在地' };
  }
  if (/什么时候.*到岗|到岗时间|入职时间|何时能.*(到|入)/.test(t)) {
    return { action: 'reply', reply: '目前在求职中,沟通顺利的话两周内可以到岗。', reason: '对方询问到岗时间' };
  }
  if (/面试|约个时间|约时间|加微信|加个微信|面聊|来公司|约面|面试邀请|面谈/.test(t)) {
    return { action: 'interview', reply: '好的，时间您定，我来配合。方便的话加个微信沟通面试细节。', reason: '对方邀约面试' };
  }
  if (/谢谢|再见|拜拜|感谢.*(关注|配合)|那就这样|就到这里/.test(t)) {
    return { action: 'closed', reply: '好的，谢谢您，有需要随时联系。', reason: '对方结束对话' };
  }
  if (/\?|？|怎么样|了解|感兴趣/.test(t)) {
    return { action: 'reply', reply: '了解的,我的经历和岗位比较匹配,想进一步沟通一下。', reason: '对方询问意向' };
  }
  return { action: 'no_action', reply: '' };
}

// ---------- 会话扫描(逐会话 + 超时,单会话失败不中断) ----------
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms))]);
}

async function readOneSession(cdp, i) {
  return cdp.evaluate(`(async () => {
    try {
      const friends = Array.from(document.querySelectorAll('.friend-content'));
      if (${i} >= friends.length) return null;
      friends[${i}].click();
      await new Promise((r) => setTimeout(r, 700));
      const cur = Array.from(document.querySelectorAll('.friend-content'))[${i}];
      if (!cur) return null;
      const name = cur.querySelector('.name-text')?.textContent?.trim() || '';
      // 校验活动会话确为目标会话(防读到别的会话消息;点击可能未生效则重试)
      let sel = document.querySelector('.friend-content.selected');
      for (let k = 0; k < 4; k++) {
        const selName = sel?.querySelector('.name-text')?.textContent?.trim() || '';
        if (selName && selName === name) break;
        await new Promise((r) => setTimeout(r, 400));
        friends[${i}].click();
        sel = document.querySelector('.friend-content.selected');
      }
      const selName = sel?.querySelector('.name-text')?.textContent?.trim() || '';
      if (selName && selName !== name) return { index: ${i}, error: '会话切换未确认' };
      const spans = Array.from(cur.querySelectorAll('.name-box span')).map((s) => s.textContent.trim());
      const company = spans[1] || name;
      const msgs = Array.from(document.querySelectorAll('.message-item')).map((m) => ({
        mid: String(m.getAttribute('data-mid') || ''),
        dir: m.classList.contains('item-friend') ? 'other' : m.classList.contains('item-system') ? 'sys' : 'me',
        time: m.querySelector('.item-time .time')?.textContent?.trim() || '',
        text: (m.querySelector('.text-content')?.textContent || m.textContent || '').replace(/\\s+/g, ' ').trim(),
      })).filter((m) => m.text);
      return { index: ${i}, name, company, sessionKey: company + '·' + name, msgs };
    } catch (e) {
      return { index: ${i}, error: String(e).slice(0, 80) };
    }
  })()`);
}

async function scanChatSessions(cdp) {
  const out = [];
  const total = await cdp.evaluate(`document.querySelectorAll('.friend-content').length`).catch(() => 0);
  for (let i = 0; i < total; i++) {
    let s;
    try {
      s = await withTimeout(readOneSession(cdp, i), 8000);
    } catch (e) {
      console.log(`[agent] 会话 ${i} 读取超时,中止扫描。`);
      break;
    }
    if (!s) break;
    if (s.error) { console.log(`[agent] 会话 ${i} 异常: ${s.error}`); continue; }
    if (s.msgs?.length) out.push(s);
  }
  return out;
}

// 找某会话中比 lastMid 更新的 HR 消息(按数值比较 mid)
export function newOtherMsgs(session, lastMid) {
  if (!lastMid) return [];
  const base = BigInt(lastMid);
  return session.msgs.filter((m) => m.dir === 'other' && m.mid && BigInt(m.mid) > base);
}

export function maxMid(msgs) {
  let mx = null;
  for (const m of msgs) {
    const id = String(m.mid || '');
    if (!id) continue;
    if (mx === null || BigInt(id) > BigInt(mx)) mx = id;
  }
  return mx;
}

// ---------- 动作执行 ----------
async function actReply(cdp, text) {
  const sent = await sendMessage(cdp, text);
  return `回复:${sent.slice(0, 30)}`;
}
async function actResume(cdp) {
  const can = await canSendResume(cdp);
  if (!can) return '发简历不可用(需互动后)';
  const r = await sendResumeRequest(cdp);
  return `发简历:${r.sent ? '✓' : '✗ ' + r.detail}`;
}

// 发送前确认活动会话是目标会话(防发错人):
//   点击目标会话(按公司+HR 名匹配,兜底扫描序号),再轮询校验 .friend-content.selected 文本含目标公司/HR。
//   返回 true 才允许发送;false 表示未确认 → 宁可跳过也不发错人。
async function ensureActiveSession(cdp, s) {
  return cdp.evaluate(`(async () => {
    try {
      const items = Array.from(document.querySelectorAll('.friend-content'));
      const c = ${JSON.stringify((s.company || '').slice(0, 5))};
      const n = ${JSON.stringify((s.name || '').slice(0, 5))};
      const target =
        items.find((x) => { const t = x.textContent || ''; return (c && t.includes(c)) && (n && t.includes(n)); })
        || items.find((x) => { const t = x.textContent || ''; return n && t.includes(n); })
        || items[${s.index}];
      if (!target) return false;
      target.click();
      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 400));
        const sel = document.querySelector('.friend-content.selected');
        const t = sel ? (sel.textContent || '') : '';
        if ((c && t.includes(c)) || (n && t.includes(n))) return true;
      }
      return false;
    } catch (e) { return false; }
  })()`);
}

// LLM 是否可用(拒绝占位符 key)
export function llmAvailable(cfg) {
  const k = (cfg.llm?.api_key || '').trim();
  return !!(cfg.llm?.enabled && k && !/填入|your.*key|xxx/i.test(k) && k.length > 8);
}

// ---------- 单轮 ----------
async function runOnce({ mock, quiet = false, chatTarget = null }) {
  const cfg = loadConfig();
  const profile = loadResumeProfile();
  const llmOn = !mock && llmAvailable(cfg);
  if (!llmOn && !quiet) console.log(`[agent] 未配置 LLM key,使用关键词兜底(建议在 config.json 配置 llm.api_key 获得 AI 对话能力)`);
  openDb(cfg.db_path);

  // 优先用 runLoop 传入的专用聊天 tab(避免与投递流程抢页);无则回退 findPage
  let page;
  let cdp;
  try {
    page = chatTarget || await findPage(isChatPage);
    if (!page) {
      await openPage(CHAT_PAGE);
      await sleep(4000);
      page = await findPage(isChatPage);
    }
    if (!page) throw new Error('聊天页不可用(浏览器未启动?)');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
  } catch (e) {
    // 专用 tab 失效(被关/浏览器重启):标记让 runLoop 下轮重新发现,避免静默死亡
    if (chatTarget) return { chatTargetDead: true, error: e.message };
    throw e;
  }
  await cdp.waitFor(`document.querySelectorAll('.friend-content').length > 0`, { timeoutMs: 15000 }).catch(() => {});

  const captcha = await detectCaptcha(cdp);
  if (captcha) { console.log(`[agent] 检测到验证码(${captcha}),本轮暂停。`); cdp.close(); closeDb(); return { paused: true }; }

  const sessions = await scanChatSessions(cdp);
  let init = 0, replied = 0, resumes = 0, rejected = 0, interviews = 0, closed = 0, noAction = 0, skipped = 0;

  // 联动 applied:标记不合适 / 已发简历 时同步投递记录状态
  const syncApplied = (s, fields) => {
    try {
      const rows = getDb().prepare('SELECT job_id FROM applied WHERE company=?').all(s.company);
      for (const r of rows) updateApplied(r.job_id, fields);
    } catch {}
  };

  for (const s of sessions) {
    const st = getAiSession(s.sessionKey);
    // 关联岗位信息(按公司匹配),首次与后续都存入 job_id
    let job = null;
    try { job = getDb().prepare('SELECT * FROM jobs WHERE company=? LIMIT 1').get(s.company) || null; } catch {}

    if (!st) {
      // 首次:登记监听,不回复
      upsertAiSession({
        session_key: s.sessionKey, company: s.company, contact: s.name, job_id: job?.job_id || null,
        status: 'active', last_mid: maxMid(s.msgs),
        last_ai_action: '初始化监听', history: { t: new Date().toISOString(), action: 'init' },
      });
      init++;
      continue;
    }
    const newReplies = newOtherMsgs(s, st.last_mid);
    if (!newReplies.length) { skipped++; continue; }

    const lastOther = newReplies[newReplies.length - 1];
    const ctx = { transcript: s.msgs, job };

    let d;
    try {
      d = llmOn ? await llmDecide(ctx, profile, cfg) : keywordDecide(ctx);
    } catch (e) {
      console.log(`[agent] ${s.company} 决策失败: ${e.message},本轮跳过。`);
      upsertAiSession({ session_key: s.sessionKey, company: s.company, contact: s.name, job_id: job?.job_id || st.job_id, status: st.status, last_mid: maxMid(s.msgs), last_ai_action: `决策失败:${e.message.slice(0,40)}`, history: { t: new Date().toISOString(), action: 'error', msg: e.message } });
      continue;
    }

    let note = d.action;
    if (d.action === 'reply') {
      // 发送前确认活动会话是目标会话,防发错人
      if (await ensureActiveSession(cdp, s)) { try { note = await actReply(cdp, d.reply); replied++; } catch (e) { note = `回复失败:${e.message}`; } }
      else note = `跳过回复:未确认活动会话是「${s.company}」`;
    } else if (d.action === 'send_resume') {
      if (await ensureActiveSession(cdp, s)) { try { note = await actResume(cdp); resumes++; syncApplied(s, { status: 'resume_sent', resume_req_at: new Date().toISOString() }); } catch (e) { note = `发简历失败:${e.message}`; } }
      else note = `跳过发简历:未确认活动会话是「${s.company}」`;
    } else if (d.action === 'mark_rejected') {
      rejected++;
      note = `标记不合适:${d.reject_reason || d.reason || ''}`;
      syncApplied(s, { status: 'rejected' });
    } else if (d.action === 'interview') {
      // HR 约面:回复确认 + 状态 interview
      if (await ensureActiveSession(cdp, s)) { try { note = await actReply(cdp, d.reply || '好的，时间您定，我来配合，方便的话加个微信沟通面试细节。'); interviews++; } catch (e) { note = `约面回复失败:${e.message}`; } }
      else note = `跳过约面回复:未确认活动会话是「${s.company}」`;
    } else if (d.action === 'closed') {
      // 对话结束:可回一句客气话收尾,状态 closed
      closed++;
      if (d.reply) { if (await ensureActiveSession(cdp, s)) { try { await actReply(cdp, d.reply); } catch {} } else note = '对话已结束(未确认活动会话,跳过收尾)'; }
      else note = '对话已结束';
    } else {
      noAction++;
      note = `无需回复${d.reason ? ':' + d.reason : ''}`;
    }

    const status = { mark_rejected: 'rejected', send_resume: 'resume_sent', interview: 'interview', closed: 'closed' }[d.action] || st.status;
    upsertAiSession({
      session_key: s.sessionKey, company: s.company, contact: s.name, job_id: job?.job_id || st.job_id,
      status, reject_reason: d.action === 'mark_rejected' ? (d.reject_reason || d.reason || null) : st.reject_reason,
      last_mid: maxMid(s.msgs), last_reply_at: lastOther.time,
      last_ai_action: note, history: { t: new Date().toISOString(), action: d.action, reason: d.reason, reply: d.reply, reject: d.reject_reason },
    });
    if (!quiet) {
      const lastOtherText = (lastOther?.text || '').slice(0, 50);
      console.log(`[agent] ${s.company}(${s.name}) → ${note}${d.reason ? ` | 依据:${d.reason}` : ''}${lastOtherText ? ` | 对方:${lastOtherText}` : ''}`);
    }

    // 限频:发送类动作间随机延迟
    if (['reply', 'send_resume', 'interview', 'closed'].includes(d.action) && d.action !== 'closed') {
      const delay = cfg.agent.min_action_delay_sec + Math.random() * (cfg.agent.max_action_delay_sec - cfg.agent.min_action_delay_sec);
      await sleep(delay * 1000);
    }
  }

  cdp.close();
  closeDb();
  const summary = { init, replied, resumes, rejected, interviews, closed, noAction, skipped };
  if (!quiet) console.log(`[agent] 本轮完成: 初始化 ${init},回复 ${replied},发简历 ${resumes},标记不合适 ${rejected},约面 ${interviews},结束 ${closed},无需动作 ${noAction},无新回复 ${skipped}`);
  return summary;
}

// ---------- 循环(持续监听,带失败退避) ----------
async function runLoop({ mock }) {
  const cfg = loadConfig();
  const interval = (cfg.agent.interval_sec || 90) * 1000;
  console.log(`[agent] AI 对话代理启动(每 ${Math.round(interval / 1000)}s 一轮)${cfg.agent.quiet_hours?.length ? `,静默时段 ${cfg.agent.quiet_hours.join('-')} 时` : ''}`);
  // 专用聊天 tab:agent 独占,避免与自动投递抢同一个聊天页
  let chatTarget = null;
  try {
    chatTarget = await findPage(isChatPage);
    if (!chatTarget) { await openPage(CHAT_PAGE); await sleep(4000); chatTarget = await findPage(isChatPage); }
    if (chatTarget) console.log('[agent] 使用聊天页 target:', chatTarget.id.slice(0, 8));
  } catch (e) { console.warn(`[agent] 初始化聊天页失败: ${e.message}`); }
  let round = 0;
  let failStreak = 0;
  while (true) {
    round++;
    const h = new Date().getHours();
    const qh = cfg.agent.quiet_hours || [];
    // 跨午夜静默(如 [23,8])也生效:start<end 用区间,start>end 用跨午夜
    const inQuiet = qh.length === 2 && (qh[0] < qh[1] ? (h >= qh[0] && h < qh[1]) : (h >= qh[0] || h < qh[1]));
    if (inQuiet) {
      console.log(`[agent] 静默时段(${h}时),等待 10 分钟后再扫。`);
      await sleep(600000);
      continue;
    }
    try {
      const r = await runOnce({ mock, quiet: round > 1, chatTarget });
      failStreak = 0;
      if (r.chatTargetDead) {
        chatTarget = null; // 专用 tab 失效,下轮重新发现,消除静默死亡
        console.log(`[agent] 专用聊天tab失效(${r.error}),下轮重新发现。`);
        await sleep(10000);
        continue;
      }
      if (r.paused) { console.log('[agent] 验证码暂停,等待 5 分钟。'); await sleep(300000); }
    } catch (e) {
      failStreak++;
      console.log(`[agent] 本轮异常: ${e.message}`);
      if (failStreak >= 3) {
        // 连续失败(多为浏览器/CDP 掉线):退避 5 分钟,避免空转刷屏
        console.log(`[agent] 连续 ${failStreak} 次失败,可能浏览器离线,退避 5 分钟。`);
        await sleep(300000);
        continue;
      }
    }
    await sleep(interval);
  }
}

// ---------- 入口 ----------
const opt = parseArgs();
if (import.meta.main) {
  if (opt.cmd === 'loop') {
    runLoop({ mock: opt.mock }).catch((e) => { console.error('[agent] 循环终止:', e.message); process.exit(1); });
  } else {
    runOnce({ mock: opt.mock }).catch((e) => { console.error('[agent] 失败:', e.message); process.exit(1); });
  }
}
