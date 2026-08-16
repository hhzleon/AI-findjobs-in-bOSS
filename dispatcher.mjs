// dispatcher.mjs — 调度层(半自动):候选清单 → 确认 → 限频投递 → 状态/反馈
// 用法:
//   node dispatcher.mjs list               # 候选清单(未投递,按总分降序,含理由)
//   node dispatcher.mjs score              # 重算评分(调 scorer)
//   node dispatcher.mjs collect            # 采集(调 collector)
//   node dispatcher.mjs apply --ids 0,2,5  # 投递指定候选(序号取 list 输出)
//   node dispatcher.mjs apply --top 3      # 投递前 3 名候选
//   node dispatcher.mjs status             # 投递/回复状态
//   node dispatcher.mjs feedback           # 扫描会话更新 hr_stats
//
// 风控:每日上限 daily_limit、随机间隔 min/max_interval_sec、验证码即暂停
import { sleep, tidyTabs, openPage, CDP, detectCaptcha } from './cdp.mjs';
import { loadConfig } from './config.mjs';
import { openDb, closeDb, listCandidates, listApplied, countAppliedToday, insertApplied, updateApplied, getApplied } from './storage.mjs';
import { clickChatButton, probeChatButton } from './jobs.mjs';
import { sendMessage, canSendResume, sendResumeRequest, currentChatInfo, selectChat } from './chat.mjs';
import { briefReason } from './scorer.mjs';

const CMD = process.argv[2] || 'list';

function argAfter(key) {
  const i = process.argv.indexOf(key);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 直接通过 SEO 详情页投递(不再翻页找卡片):
//   导航到 /job_detail/{jobId}.html → 探测按钮 → 立即沟通:稳健打开聊天 → 发问候语(可选发简历)
//   已沟通/继续沟通:记录后跳过(不占用今日打招呼上限)
// 返回: { ok, status, detail, blocked, steps }
async function applyViaDetailPage(jobsCdp, c, cfg, { resume = false, dryRun = false } = {}) {
  const now = () => new Date().toISOString();
  const url = `https://www.zhipin.com/job_detail/${c.job_id}.html`;
  // 若当前不在该岗位详情页则导航过去(首个岗位新开 tab 已就位,后续复用导航)
  const cur = await jobsCdp.evaluate('location.href');
  if (!cur.includes(c.job_id)) {
    console.log(`  导航详情页: ${url.slice(0, 88)}`);
    await jobsCdp.send('Page.navigate', { url });
    await sleep(4000);
  }
  // 验证码检查
  const captcha = await detectCaptcha(jobsCdp);
  if (captcha) return { ok: false, status: 'pending', steps: { captcha }, detail: `检测到验证码(${captcha}),已暂停` };

  // 轮询按钮出现
  let st = null;
  const dl = Date.now() + 10000;
  while (Date.now() < dl) {
    st = await probeChatButton(jobsCdp);
    if (st.found) break;
    await sleep(800);
  }
  if (!st || !st.found) return { ok: false, status: 'pending', detail: '详情页未找到「立即沟通/继续沟通」按钮' };

  // 已沟通 / 继续沟通:已投过 → 记录后跳过(不占用今日打招呼上限)
  if (st.done || st.button === '继续沟通') {
    if (!dryRun) {
      const row = getApplied(c.job_id);
      if (row) updateApplied(c.job_id, { status: 'greeted' });
      else insertApplied({ job_id: c.job_id, title: c.title, company: c.company, status: 'greeted' });
    }
    return { ok: false, status: 'greeted', detail: `按钮「${st.button}」,该岗位已沟通过,跳过` };
  }
  if (st.button !== '立即沟通') return { ok: false, status: 'pending', detail: `未知按钮状态「${st.button}」` };

  // 立即沟通:稳健打开聊天(真实坐标点击 + 弹窗识别 + add.json 兜底)
  const r = await clickChatButton(jobsCdp, { timeoutMs: 25000 });
  if (r.blocked) return { ok: false, status: 'pending', blocked: r.blocked, detail: `被「${r.modal}」弹窗阻断` };
  if (!r.entered) return { ok: false, status: 'pending', detail: r.detail };

  // 进入聊天页:记录已投 + 发问候语(BOSS 默认招呼已关闭,必须手动发)
  if (!dryRun) {
    const row = getApplied(c.job_id);
    if (row) updateApplied(c.job_id, { greeted_at: now(), status: 'greeted' });
    else insertApplied({ job_id: c.job_id, title: c.title, company: c.company, greeted_at: now(), status: 'greeted' });
  }
  await sleep(1500);
  const info = await currentChatInfo(jobsCdp).catch(() => ({ chat: '' }));
  console.log(`  当前会话: ${(info.chat || '').slice(0, 60) || '(未知)'}`);
  // 安全网:确认活动会话是目标公司,避免问候语发错 HR(无人值守下宁可跳过发消息)
  const compKey = (c.company || '').replace(/\.\.\..*$/, '').trim();
  let chatOk = true;
  if (info.chat && compKey && !info.chat.includes(compKey)) {
    const switched = await selectChat(jobsCdp, compKey.slice(0, 8)).catch(() => false);
    console.log(`  活动会话与「${compKey}」不符,尝试定位: ${switched ? '已切换' : '未找到,跳过发消息'}`);
    chatOk = !!switched;
  }

  let msgSent = false, resumeSent = false;
  if (!dryRun) {
    if (!chatOk) {
      console.log('  未确认目标会话,跳过发消息(避免发错 HR)。');
    } else {
      const message = cfg.greeting_message;
      console.log(`  发送消息: ${message.slice(0, 40)}…`);
      msgSent = await sendMessage(jobsCdp, message);
      console.log(`  已发送: ${msgSent}`);
      if (resume && msgSent) {
        const can = await canSendResume(jobsCdp);
        if (!can) console.log('      「发简历」按钮当前不可用(BOSS 要求双方互动后可用)。');
        else {
          const rr = await sendResumeRequest(jobsCdp);
          console.log(`  发简历: ${rr.sent ? '✓ ' + rr.detail : '✗ ' + rr.detail}`);
          resumeSent = rr.sent;
        }
      }
    }
    updateApplied(c.job_id, {
      msg_sent_at: msgSent ? now() : null,
      resume_req_at: resumeSent ? now() : null,
      status: resumeSent ? 'resume_sent' : (msgSent ? 'msg_sent' : 'greeted'),
    });
  } else {
    console.log('  (dry-run) 跳过发消息/发简历');
  }

  return {
    ok: true,
    status: resumeSent ? 'resume_sent' : (msgSent ? 'msg_sent' : 'greeted'),
    detail: `${r.detail}${msgSent ? ' +消息' : ''}${resumeSent ? ' +简历' : ''}`,
  };
}

// ---------- list ----------
async function cmdList(cfg) {
  const threshold = argAfter('--threshold') !== undefined ? Number(argAfter('--threshold')) : cfg.score_threshold;
  const rows = listCandidates({ minScore: threshold, excludeApplied: true, limit: 100 });
  console.log(`候选清单(≥${threshold} 分,未投递):${rows.length} 条\n`);
  if (!rows.length) { console.log('(空。先 node dispatcher.mjs collect && node dispatcher.mjs score)'); return; }
  rows.forEach((r, i) => {
    const detail = JSON.parse(r.score_detail || '{}');
    const reason = briefReason({ job: r, similarity: detail.similarity, llm: detail.llm, mDetail: detail.match || {}, aDetail: detail.active || {} });
    const act = (r.boss_activity || '-').padEnd(8);
    const tag = (JSON.parse(r.tags || '[]').slice(0, 3).join('/') || '-');
    console.log(`#${i} [${r.total_score}分] ${r.title} | ${r.salary || '-'} | ${r.company} | ${r.location || '-'}`);
    console.log(`   匹配${r.match_score} 活跃${r.active_score} | HR:${act} | ${tag}`);
    console.log(`   理由: ${reason}`);
  });
  console.log(`\n投递: node dispatcher.mjs apply --ids <序号,逗号分隔>`);
}

// ---------- apply ----------
async function cmdApply(cfg) {
  const idsRaw = argAfter('--ids');
  const topRaw = argAfter('--top');
  const minRaw = argAfter('--min');
  const resume = process.argv.includes('--resume');
  const dryRun = process.argv.includes('--dry-run');

  // 选择模式:--min 自动投递全部≥分;--ids 指定序号;--top 前N名
  let selected;
  if (minRaw !== undefined) {
    const minScore = Number(minRaw);
    const rows = listCandidates({ minScore, excludeApplied: true, limit: 100 });
    console.log(`自动投递:全部 ≥${minScore} 分候选,共 ${rows.length} 条`);
    selected = rows;
  } else {
    const threshold = argAfter('--threshold') !== undefined ? Number(argAfter('--threshold')) : cfg.score_threshold;
    const rows = listCandidates({ minScore: threshold, excludeApplied: true, limit: 100 });
    if (!rows.length) { console.log('无可投递候选'); return; }
    if (idsRaw !== undefined) {
      const ids = idsRaw.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
      selected = ids.map((id) => rows[id]).filter(Boolean);
      const missing = ids.filter((id) => !rows[id]);
      if (missing.length) console.log(`忽略无效序号: ${missing.join(',')}(共 ${rows.length} 个候选)`);
    } else if (topRaw !== undefined) {
      selected = rows.slice(0, Number(topRaw));
    } else {
      console.log('用法: node dispatcher.mjs apply --ids 0,2,5 或 --top 3 或 --min 70');
      return;
    }
  }
  if (!selected.length) { console.log('没有可投递的岗位'); return; }

  // 每日上限检查
  const today = countAppliedToday();
  const remaining = cfg.daily_limit - today;
  if (remaining <= 0) {
    console.log(`今日打招呼已达上限(${cfg.daily_limit}),停止投递。明天再试。`);
    return;
  }
  console.log(`\n计划投递 ${selected.length} 个(今日已投 ${today}/${cfg.daily_limit})${resume ? ' +发简历' : ''}${dryRun ? ' [dry-run]' : ''}\n`);

  let jobsCdp = null;
  let done = 0;
  let skipped = 0;
  try {
    for (const [i, c] of selected.entries()) {
      if (done >= remaining) {
        console.log(`\n已达今日上限(${cfg.daily_limit}),停止。`);
        break;
      }
      if (i > 0) {
        const wait = cfg.min_interval_sec + Math.random() * (cfg.max_interval_sec - cfg.min_interval_sec);
        console.log(`\n等待 ${Math.round(wait)}s 再投下一个…`);
        await sleep(wait * 1000);
      }
      console.log(`\n(${done + 1}/${Math.min(selected.length, remaining)}) [${c.title}] | ${c.company}`);
      // 本轮工作页:首个岗位新开详情页 tab,后续岗位复用导航(免去卡片定位/翻页)
      if (!jobsCdp) {
        const target = await openPage(`https://www.zhipin.com/job_detail/${c.job_id}.html`);
        jobsCdp = await CDP.connect(target.webSocketDebuggerUrl);
      }
      let r;
      try {
        r = await applyViaDetailPage(jobsCdp, c, cfg, { resume, dryRun });
      } catch (e) {
        // 单个岗位异常不中断整批(无人监管下避免一错全停)
        skipped++;
        console.log(`[${c.title}] 投递异常: ${e.message},跳过该岗位。`);
        await tidyTabs({ maxChat: 2 });
        continue;
      }
      await tidyTabs({ maxChat: 2 }); // 控制 tab 数量:保留 1 个岗位页 + 2 个聊天页
      if (r.ok) done++;
      else {
        skipped++;
        // 阻断性弹窗:登录过期 / 简历未完善 → 停止整批(避免反复无意义重试)
        if (r.blocked === 'login') {
          console.log(`检测到登录弹窗,会话可能已过期。请手动重新登录后重试。`);
          break;
        }
        if (r.blocked === 'resume') {
          console.log(`检测到「完善简历」弹窗。请先在 BOSS 完善在线简历后再启动投递。`);
          break;
        }
        if (r.steps?.captcha) {
          console.log(`检测到验证码,暂停后续投递。请在浏览器中手动处理。`);
          break;
        }
        if (!/已沟通过/.test(r.detail)) console.log(`投递未完成: ${r.detail}`);
      }
    }
  } finally {
    if (jobsCdp) jobsCdp.close();
  }
  console.log(`\n=== 本轮完成:成功 ${done},跳过 ${skipped} ===`);
}

// ---------- status ----------
async function cmdStatus() {
  const rows = listApplied();
  if (!rows.length) { console.log('还没有投递记录。'); return; }
  console.log(`投递记录:${rows.length} 条\n`);
  rows.forEach((r) => {
    const g = r.greeted_at ? r.greeted_at.slice(5, 16) : '-';
    const rep = r.reply_delay_sec != null ? `${Math.round(r.reply_delay_sec / 60)}分钟` : '-';
    console.log(`[${r.status}] ${r.title} | ${r.company} | 招呼:${g} | 回复延迟:${rep}`);
  });
}

// ---------- feedback ----------
async function cmdFeedback() {
  const { runHrStats } = await import('./hrstats.mjs');
  await runHrStats({ limit: 50 });
}

// ---------- collect / score ----------
async function cmdCollect() {
  const { runCollector } = await import('./collector.mjs');
  await runCollector({});
}

async function cmdScore() {
  const { runScoring } = await import('./scorer.mjs');
  await runScoring({});
}

async function main() {
  const cfg = loadConfig();
  openDb(cfg.db_path);

  switch (CMD) {
    case 'list': await cmdList(cfg); break;
    case 'apply': await cmdApply(cfg); break;
    case 'status': await cmdStatus(); break;
    case 'feedback': await cmdFeedback(); break;
    case 'collect': await cmdCollect(); break;
    case 'score': await cmdScore(); break;
    default:
      console.log('用法: node dispatcher.mjs <list|apply|status|feedback|collect|score>');
      console.log('  list     候选清单(默认 ≥ score_threshold)');
      console.log('  apply    投递 --ids 0,2,5 或 --top 3 [--resume] [--dry-run]');
      console.log('  status   投递/回复状态');
      console.log('  feedback 扫描会话更新 hr_stats');
      console.log('  collect  采集新岗位(node collector.mjs)');
      console.log('  score    重算评分(node scorer.mjs)');
  }
  closeDb();
}

main().catch((e) => {
  console.error('\n执行失败:', e.message);
  process.exit(1);
});
