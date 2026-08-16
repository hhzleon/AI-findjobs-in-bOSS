// hrstats.mjs — HR 活跃度反馈:扫描聊天会话,计算对方首次回复延迟,回写 hr_stats + applied
// 用法:
//   node hrstats.mjs                # 扫描全部会话(默认前 50 个)
//   node hrstats.mjs --limit 20     # 只扫最近 20 个会话
//   node hrstats.mjs --dry-run      # 只统计,不写库
//
// 说明:
//   - 对方消息 class 为 .message-item.item-friend;我方为 .item-myself;系统消息 .item-system
//   - 回复延迟 = 对方首条消息时间 - 我方打招呼时间(按公司聚合到 hr_stats.boss_key)
//   - 无回复或数据不足的会话不影响冷启动评分(评分侧对无数据取中性)
import { CDP, sleep, findPage, openPage } from './cdp.mjs';
import { loadConfig } from './config.mjs';
import { openDb, closeDb, upsertHrStat, updateApplied, listApplied, getJob } from './storage.mjs';

const CHAT_PAGE = 'https://www.zhipin.com/web/geek/chat';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    limit: get('--limit') !== undefined ? Number(get('--limit')) : 50,
    dryRun: args.includes('--dry-run'),
  };
}

// 解析聊天时间文本为绝对时间(相对“now”)
export function parseChatTime(s, now) {
  s = (s || '').trim();
  if (!s) return null;
  let m;
  // 2026-08-13 14:45 / 2026/8/13 14:45
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/))) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  }
  // 08-13 14:45(本年)
  if ((m = s.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/))) {
    return new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], 0, 0);
  }
  // 昨天 14:45
  if (s.includes('昨天')) {
    m = s.match(/(\d{1,2}):(\d{2})/);
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    if (m) d.setHours(+m[1], +m[2], 0, 0);
    return d;
  }
  // 14:45(今天)
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now);
    d.setHours(+m[1], +m[2], 0, 0);
    return d;
  }
  // 兜底:提取任意 HH:mm
  if ((m = s.match(/(\d{1,2}):(\d{2})/))) {
    const d = new Date(now);
    d.setHours(+m[1], +m[2], 0, 0);
    return d;
  }
  return null;
}

// 给 Promise 加超时(防页面挂起导致整轮卡死)
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms)),
  ]);
}

// 点击第 i 个会话并读取该会话信息(单次 evaluate,带 try/catch)
async function readSession(cdp, i) {
  return cdp.evaluate(`(async () => {
    try {
      const friends = Array.from(document.querySelectorAll('.friend-content'));
      if (${i} >= friends.length) return null;
      friends[${i}].click();
      await new Promise((r) => setTimeout(r, 600));
      // 点击后列表可能重渲染,重新查询
      const cur = Array.from(document.querySelectorAll('.friend-content'))[${i}];
      if (!cur) return null;
      const name = cur.querySelector('.name-text')?.textContent?.trim() || '';
      const nameBox = cur.querySelector('.name-box');
      const spans = nameBox ? Array.from(nameBox.querySelectorAll('span')) : [];
      const company = (spans[1]?.textContent?.trim())
        || (cur.querySelector('.title-box')?.textContent?.trim().split(/\\s+/)[1] || '');
      const msgs = Array.from(document.querySelectorAll('.message-item'));
      const t = (el) => el?.querySelector('.item-time .time, .time')?.textContent?.trim() || '';
      const firstMine = msgs.find((m) => m.classList.contains('item-myself'));
      const firstReply = msgs.find((m) => m.classList.contains('item-friend'));
      return {
        i: ${i},
        name,
        company,
        greetTime: firstMine ? t(firstMine) : null,
        greetText: firstMine ? firstMine.querySelector('.text-content')?.textContent?.trim().slice(0, 30) || null : null,
        replyTime: firstReply ? t(firstReply) : null,
        replyText: firstReply ? firstReply.querySelector('.text-content')?.textContent?.trim().slice(0, 30) || null : null,
      };
    } catch (e) {
      return { i: ${i}, error: String(e) };
    }
  })()`);
}

// 主扫描:逐会话遍历(每次独立 evaluate + 超时,单会话失败不中断)
async function scanAll(cdp, limit, dryRun, now) {
  const applied = listApplied();
  const appliedByCompany = new Map(applied.map((a) => [a.company, a]));

  const raw = [];
  let scanned = 0;
  for (let i = 0; i < limit; i++) {
    let s;
    try {
      s = await withTimeout(readSession(cdp, i), 8000);
    } catch (e) {
      console.log(`[${i}] 会话读取失败(页面可能挂起): ${e.message},中止本轮扫描。`);
      break;
    }
    if (!s) break; // 会话列表已读完
    scanned++;
    if (s.error) {
      console.log(`[${i}] 会话读取异常: ${s.error}`);
      continue;
    }
    const company = s.company || s.name;
    if (!company) continue;
    const greetAt = parseChatTime(s.greetTime, now);
    const replyAt = parseChatTime(s.replyTime, now);
    let delaySec = null;
    if (greetAt && replyAt && replyAt > greetAt) {
      delaySec = Math.round((replyAt - greetAt) / 1000);
    }
    const hadReply = !!delaySec;

    console.log(`[${s.i}] ${s.name || '?'} | ${company}`);
    if (s.greetTime) console.log(`     打招呼 ${s.greetTime}: ${(s.greetText || '').slice(0, 24)}`);
    if (s.replyTime) console.log(`     首回复 ${s.replyTime}: ${(s.replyText || '').slice(0, 24)}`);
    console.log(`     回复延迟: ${delaySec != null ? `${Math.round(delaySec / 60)} 分钟` : '无回复'}`);

    if (!dryRun && company) {
      upsertHrStat({
        boss_key: company, company, contact: s.name || null,
        reply_count: hadReply ? 1 : 0,
        avg_reply_sec: delaySec,
        add_reply: hadReply,
        min_reply_sec: delaySec,
        last_reply_at: hadReply ? replyAt.toISOString() : null,
      });
      // 回写 applied(按公司匹配)
      const appliedRow = appliedByCompany.get(company);
      if (appliedRow && hadReply) {
        updateApplied(appliedRow.job_id, {
          reply_at: replyAt.toISOString(),
          reply_delay_sec: delaySec,
          status: 'replied',
        });
      }
    }
    raw.push(s);
  }
  const replied = raw.filter((s) => {
    const g = parseChatTime(s.greetTime, now);
    const r = parseChatTime(s.replyTime, now);
    return g && r && r > g;
  }).length;
  return { scanned, updated: scanned, replied };
}

// 主流程(可被 dispatcher 复用)
export async function runHrStats(opt = {}) {
  const cfg = loadConfig();
  openDb(cfg.db_path);

  let page = await findPage((t) => t.url.includes('web/geek/chat'));
  if (!page) {
    await openPage(CHAT_PAGE);
    await sleep(4000);
    page = await findPage((t) => t.url.includes('web/geek/chat'));
  }
  if (!page) throw new Error('无法打开聊天页');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.waitFor(`document.querySelectorAll('.friend-content').length > 0`, { timeoutMs: 15000 }).catch(() => {});

  if (!opt.quiet) console.log(`扫描会话(前 ${opt.limit} 个)${opt.dryRun ? ' [dry-run,不写库]' : ''}`);
  const r = await scanAll(cdp, opt.limit, opt.dryRun, new Date());
  if (!opt.quiet) {
    console.log(`\n=== HR 活跃度扫描完成 ===`);
    console.log(`扫描 ${r.scanned} 会话,写入 ${r.updated} 条 HR 统计,其中对方已回复 ${r.replied} 个`);
  }
  cdp.close();
  closeDb();
  return r;
}

async function main() {
  const opt = parseArgs();
  await runHrStats(opt);
}

// 仅作为 CLI 直接运行时执行(被 dispatcher import 时不触发)
if (import.meta.main) {
  main().catch((e) => {
    console.error('\nHR 统计失败:', e.message);
    process.exit(1);
  });
}
