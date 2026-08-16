// server.mjs — 零依赖 Web 管理面板:封装 dispatcher 采集/评分/投递/反馈
// 用法:
//   node server.mjs              # 启动,默认 http://localhost:8111
//   PORT=9000 node server.mjs    # 改端口
//
// API:
//   GET  /                    静态页 web/index.html
//   GET  /api/stats           统计 + CDP 在线状态
//   GET  /api/candidates?min= 候选清单(含可解释理由)
//   GET  /api/applied         投递记录
//   GET  /api/hrstats         HR 活跃统计
//   GET  /api/log?since=N     增量日志(轮询)
//   POST /api/run {cmd,args}  启动任务:collect|score|feedback|apply(子进程,日志流入 /api/log)
//   聊天(任务运行期间互斥):
//   GET  /api/chat/sessions   会话列表
//   POST /api/chat/open  {index}        打开会话并读消息
//   POST /api/chat/send   {index?,text} 发消息(可选先切到该会话)
//   POST /api/chat/resume {index?}      发简历请求
import { createServer } from 'node:http';
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, findPage, openPage, CDP, tidyTabs } from './cdp.mjs';
import { sendMessage, sendResumeRequest, canSendResume } from './chat.mjs';
import { loadConfig } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let PORT = Number(process.env.PORT || 8111);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.warn(`[server] PORT 无效(${process.env.PORT}),使用默认 8111。`);
  PORT = 8111;
}
const CDP_PORT = process.env.CDP_PORT || '9222';
const WEB_DIR = resolve(__dirname, 'web');
const DB_PATH = resolve(__dirname, loadConfig().db_path || 'data/apply.db');
openDb(DB_PATH); // 启动即钉住数据库路径,避免 meta 读写分叉

// ---------- 轻量 DB 读取(storage 单例会与子进程并发写,WAL 模式支持) ----------
import { openDb, closeDb, getDb, listAiSessions, countAiSessions, countAppliedToday, getMeta, setMeta } from './storage.mjs';
import { briefReason } from './scorer.mjs';

// ---------- 任务运行器(单槽位 + 日志环形缓冲 + 文件持久化) ----------
const LOG_DIR = resolve(__dirname, 'data', 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const PANEL_LOG = resolve(LOG_DIR, 'panel.log');
const AGENT_LOG = resolve(LOG_DIR, 'agent.log');

function persistLog(file, entry) { try { appendFileSync(file, `${entry.ts}|${entry.line}\n`, 'utf8'); } catch {} }
function loadLogFile(file, into, max) {
  try {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max);
    for (const l of lines) {
      const m = l.match(/^(\d+)\|(.*)$/);
      if (m) into.push({ i: into.length, ts: Number(m[1]), line: m[2] });
    }
  } catch {}
}

const logBuf = [];
let running = null;

function logLine(line) {
  const clean = String(line).replace(/\r?\n$/, '');
  if (!clean) return;
  const entry = { i: logBuf.length, ts: Date.now(), line: clean };
  logBuf.push(entry);
  if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
  persistLog(PANEL_LOG, entry);
}

function runTask(cmd, args = []) {
  if (running) return { ok: false, error: `已有任务运行中: ${running.label}` };
  const label = `dispatcher ${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
  logLine(`>>> 开始: ${label}`);
  const child = spawn(process.execPath, ['dispatcher.mjs', cmd, ...args], {
    cwd: __dirname, shell: false, windowsHide: true,
  });
  running = { cmd, label, child, startedAt: new Date() };
  child.stdout.on('data', (d) => String(d).split('\n').forEach(logLine));
  child.stderr.on('data', (d) => String(d).split('\n').forEach(logLine));
  child.on('error', (e) => { logLine(`!! 启动失败: ${e.message}`); running = null; });
  child.on('exit', (code) => {
    logLine(`>>> 结束: ${label}(退出码 ${code})`);
    running = null;
  });
  // 最长运行看护:超过 60 分钟强制 kill,防止渲染进程卡死导致单槽位永久锁死调度链
  const watchdog = setTimeout(() => {
    if (running?.child === child) {
      logLine(`!!! 任务超时(60min),强制终止: ${label}`);
      try { child.kill(); } catch {}
    }
  }, 60 * 60 * 1000);
  child.on('exit', () => clearTimeout(watchdog));
  return { ok: true, child };
}

// ---------- 定时调度器(自动采集 + 评分 + 可选自动投递) ----------
// 运行时开关持久化到 meta,服务器重启后保持(否则无人监管下重启会丢状态)
const _schedCfg = loadConfig();
function metaOn(key, configVal) {
  const v = getMeta(key);
  return v !== null ? v === '1' : !!configVal;
}
function metaNum(key, configVal, def) {
  const v = getMeta(key);
  return v !== null ? Math.max(1, Number(v) || def) : Math.max(1, configVal || def);
}
let schedEnabled = metaOn('sched_enabled', _schedCfg.scheduler?.enabled);
const schedIntervalMin = metaNum('sched_interval', _schedCfg.scheduler?.collect_interval_min, 60);
let lastCollectAt = (() => {
  const v = getMeta('last_collect_at');
  return v ? Number(v) || Date.now() : Date.now(); // 重启后沿用上次采集时间,避免周期被推迟
})();
let autoApplyEnabled = metaOn('autoapply_enabled', _schedCfg.auto_apply?.enabled);
const autoApplyMin = _schedCfg.auto_apply?.min_score || 70;

function chatLockReason() {
  if (agentChild) return 'AI 助手运行中(聊天页由 AI 托管)';
  if (running && ['apply', 'feedback'].includes(running.cmd)) return `任务运行中(${running.label})`;
  return null;
}

function checkSchedule() {
  if (!schedEnabled) return;
  if (running) return;                 // 已有任务,跳过本轮
  const elapsedMin = (Date.now() - lastCollectAt) / 60000;
  if (elapsedMin < schedIntervalMin) return;
  cdpOnline().then((ok) => {
    if (!ok) { logLine(`[调度] 浏览器离线,跳过自动采集。`); lastCollectAt = Date.now(); setMeta('last_collect_at', String(lastCollectAt)); return; }
    logLine(`[调度] 距上次采集 ${Math.round(elapsedMin)} 分钟,自动采集+评分${autoApplyEnabled ? `+自动投递≥${autoApplyMin}` : ''}…`);
    // 失败短退避:把 lastCollectAt 设回「距目标还差 N 分钟」,实现 N 分钟后再试,而不是等满整个周期
    const backoffCollect = (min) => {
      lastCollectAt = Date.now() - (schedIntervalMin - min) * 60000;
      setMeta('last_collect_at', String(lastCollectAt));
    };
    const r = runTask('collect');
    if (r.ok) {
      // 链式:collect 成功(退出码0)才推进 lastCollectAt 并继续 score → (可选)apply
      r.child.once('exit', (code) => {
        if (!schedEnabled || running) return;
        if (code !== 0) {
          const b = Math.min(5, schedIntervalMin - 1);
          backoffCollect(b);
          logLine(`[调度] 采集失败(退出码 ${code}),${b} 分钟后重试。`);
          return;
        }
        lastCollectAt = Date.now();
        setMeta('last_collect_at', String(lastCollectAt)); // 成功才推进
        const r2 = runTask('score');
        if (r2.ok) {
          r2.child.once('exit', (code2) => {
            if (!schedEnabled || running) return;
            if (code2 !== 0) { logLine(`[调度] 评分失败(退出码 ${code2}),中止本轮。`); return; }
            if (!autoApplyEnabled) return;
            logLine(`[调度] 自动投递全部 ≥${autoApplyMin} 分候选…`);
            runTask('apply', ['--min', String(autoApplyMin)]);
          });
        }
      });
    } else {
      const b = Math.min(5, schedIntervalMin - 1);
      backoffCollect(b);
      logLine(`[调度] 采集启动失败: ${r.error},${b} 分钟后重试。`);
    }
  });
}
setInterval(checkSchedule, 60000);
// 定期清理多余页签(防 tab 无限增长:保留 1 个岗位页 + 2 个聊天页)
setInterval(() => { tidyTabs({ maxJobs: 1, maxChat: 2 }).catch(() => {}); }, 120000);
function nextCollectInMin() {
  if (!schedEnabled) return null;
  return Math.max(0, Math.round(schedIntervalMin - (Date.now() - lastCollectAt) / 60000));
}

// ---------- AI 对话代理进程(独立常驻,不受任务互斥锁限制) ----------
let agentChild = null;
let agentStartedAt = null;
let agentLog = [];

function agentLogLine(line) {
  const clean = String(line).replace(/\r?\n$/, '');
  if (!clean) return;
  const entry = { i: agentLog.length, ts: Date.now(), line: clean };
  agentLog.push(entry);
  if (agentLog.length > 400) agentLog.splice(0, agentLog.length - 400);
  persistLog(AGENT_LOG, entry);
}

let agentCrashStreak = 0;
function startAgent() {
  if (agentChild) return { ok: false, error: 'AI 助手已在运行' };
  agentLogLine('>>> 启动 AI 对话代理');
  const child = spawn(process.execPath, ['agent.mjs', 'loop'], { cwd: __dirname, shell: false, windowsHide: true });
  agentChild = child;
  agentStartedAt = new Date();
  agentCrashStreak = 0;
  setMeta('agent_enabled', '1'); // 持久化:重启后自动恢复
  child.stdout.on('data', (d) => String(d).split('\n').forEach(agentLogLine));
  child.stderr.on('data', (d) => String(d).split('\n').forEach(agentLogLine));
  child.on('error', (e) => { agentLogLine(`!! 启动失败: ${e.message}`); agentChild = null; });
  child.on('exit', (code) => {
    agentLogLine(`>>> AI 对话代理已停止(退出码 ${code})`);
    agentChild = null;
    const uptimeMs = agentStartedAt ? Date.now() - agentStartedAt.getTime() : 0;
    agentStartedAt = null;
    if (getMeta('agent_enabled') !== '1') return; // 主动停止,不重启
    // 崩溃自愈:启动即崩(存活<15s)退避 1 分钟;连续 5 次熔断,停止自动恢复
    if (uptimeMs < 15000) {
      agentCrashStreak++;
      if (agentCrashStreak >= 5) {
        setMeta('agent_enabled', '0');
        agentLogLine('!!! 代理连续崩溃 5 次,已熔断(meta agent_enabled=0),停止自动恢复。');
        return;
      }
    } else {
      agentCrashStreak = 0;
    }
    const delay = uptimeMs < 15000 ? 60000 : 10000;
    setTimeout(() => { if (getMeta('agent_enabled') === '1' && !agentChild) startAgent(); }, delay);
  });
  return { ok: true };
}

function stopAgent() {
  if (!agentChild) return { ok: false, error: 'AI 助手未在运行' };
  agentLogLine('>>> 停止 AI 对话代理');
  setMeta('agent_enabled', '0'); // 持久化:重启后不恢复
  try { agentChild.kill(); } catch {}
  return { ok: true };
}

function agentStatus() {
  return { running: !!agentChild, startedAt: agentStartedAt, runningLabel: agentChild ? 'agent' : null };
}

// ---------- 数据查询 ----------
function readStats() {
  openDb(DB_PATH);
  const d = getDb();
  const c = (sql) => { try { return d.prepare(sql).get().c; } catch { return 0; } };
  const now = () => new Date().toISOString().slice(0, 10);
  // 今日已投:复用 storage.countAppliedToday(本地时区,与 dispatcher 的每日上限同一算法)
  let todayApplied = 0;
  try { todayApplied = countAppliedToday(); } catch {};
  const stats = {
    jobs: c('SELECT COUNT(*) c FROM jobs'),
    jobsWithJd: c('SELECT COUNT(*) c FROM jobs WHERE jd_fetched=1'),
    jobsUrgent: c('SELECT COUNT(*) c FROM jobs WHERE is_urgent=1'),
    candidates: c('SELECT COUNT(*) c FROM candidates'),
    candidatesMin60: c('SELECT COUNT(*) c FROM candidates WHERE total_score>=60'),
    applied: c('SELECT COUNT(*) c FROM applied'),
    appliedToday: todayApplied,
    hrStats: c('SELECT COUNT(*) c FROM hr_stats'),
    hrReplied: c('SELECT COUNT(*) c FROM hr_stats WHERE reply_count>0'),
    updatedAt: now(),
  };
  closeDb();
  return stats;
}

async function cdpOnline() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://localhost:${CDP_PORT}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

function listCandidatesApi(min) {
  openDb(DB_PATH);
  const d = getDb();
  const rows = d.prepare(`
    SELECT j.*, c.match_score, c.active_score, c.total_score, c.score_method, c.score_detail
    FROM candidates c JOIN jobs j ON j.job_id = c.job_id
    LEFT JOIN applied a ON a.job_id = j.job_id
    WHERE (a.job_id IS NULL OR (a.status='pending' AND a.created_at <= datetime('now','localtime','-10 minutes'))) AND c.total_score >= ?
    ORDER BY c.total_score DESC
    LIMIT 100
  `).all(min);
  closeDb();
  return rows;
}

function readApplied() {
  openDb(DB_PATH);
  const rows = getDb().prepare('SELECT * FROM applied ORDER BY greeted_at DESC LIMIT 200').all();
  closeDb();
  return rows.map((r) => ({
    job_id: r.job_id, title: r.title, company: r.company, total_score: r.total_score,
    status: r.status, greeted_at: r.greeted_at, msg_sent_at: r.msg_sent_at,
    resume_req_at: r.resume_req_at, reply_delay_sec: r.reply_delay_sec,
  }));
}

function readHrStats() {
  openDb(DB_PATH);
  const rows = getDb().prepare('SELECT * FROM hr_stats ORDER BY reply_count DESC, last_active_at DESC LIMIT 200').all();
  closeDb();
  return rows.map((r) => ({
    boss_key: r.boss_key, company: r.company, contact: r.contact,
    reply_count: r.reply_count, avg_reply_sec: r.avg_reply_sec, min_reply_sec: r.min_reply_sec,
    last_active_at: r.last_active_at, last_reply_at: r.last_reply_at,
  }));
}

// ---------- 聊天(CDP 驱动聊天页,每次操作即连即断) ----------
const CHAT_PAGE = 'https://www.zhipin.com/web/geek/chat';
const isChatPage = (t) => t.url.includes('web/geek/chat');

// 串行化聊天页操作:同一时刻只有一个请求驱动聊天页,避免并发点击/读取互相干扰
let chatChain = Promise.resolve();
function withChatLock(fn) {
  const run = chatChain.then(() => fn());
  chatChain = run.then(() => {}, () => {});
  return run;
}

async function withChatPage(fn) {
  let page = await findPage(isChatPage);
  if (!page) {
    await openPage(CHAT_PAGE);
    await sleep(4000);
    page = await findPage(isChatPage);
  }
  if (!page) throw new Error('聊天页不可用(浏览器未启动?先运行 start-browser.bat)');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  try {
    await cdp.waitFor(`document.querySelectorAll('.friend-content').length > 0`, { timeoutMs: 12000 }).catch(() => {});
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

// 会话列表
async function chatSessions() {
  return withChatPage(async (cdp) => cdp.evaluate(`
    Array.from(document.querySelectorAll('.friend-content')).map((el, i) => {
      const name = el.querySelector('.name-text')?.textContent?.trim() || '';
      const spans = Array.from(el.querySelectorAll('.name-box span')).map(s => s.textContent.trim());
      const unread = !!el.querySelector('[class*="unread"], .badge-count, [class*="msg-count"]');
      return {
        index: i, name,
        company: spans[1] || '', role: spans[3] || '',
        lastMsg: (el.querySelector('.last-msg')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        time: el.querySelector('.time')?.textContent?.trim() || '',
        unread,
      };
    })
  `));
}

// 打开会话并读消息
async function chatOpen(index) {
  return withChatPage(async (cdp) => {
    const ok = await cdp.evaluate(`(() => {
      const el = document.querySelectorAll('.friend-content')[${index}];
      if (!el) return false;
      el.click(); return true;
    })()`);
    if (!ok) throw new Error(`会话索引越界: ${index}`);
    await sleep(1300);
    const messages = await cdp.evaluate(`
      Array.from(document.querySelectorAll('.message-item')).map((m) => {
        const cls = m.className || '';
        const dir = cls.includes('item-friend') ? 'other' : cls.includes('item-system') ? 'sys' : 'me';
        return {
          dir,
          time: m.querySelector('.item-time .time')?.textContent?.trim() || '',
          text: m.querySelector('.text-content')?.textContent?.trim() || (m.textContent || '').replace(/\\s+/g, ' ').trim(),
        };
      })
    `);
    const chatInfo = await cdp.evaluate(`(() => {
      const sel = document.querySelector('.friend-content.selected');
      return sel ? sel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null;
    })()`);
    return { index, chatInfo, messages };
  });
}

// 发送消息(可选先切到会话)
async function chatSend(index, text) {
  if (!text || !text.trim()) throw new Error('消息内容为空');
  return withChatPage(async (cdp) => {
    if (index != null) {
      const ok = await cdp.evaluate(`(() => {
        const el = document.querySelectorAll('.friend-content')[${index}];
        if (!el) return false;
        el.click(); return true;
      })()`);
      if (!ok) throw new Error(`会话索引越界: ${index}`);
      await sleep(1300);
    }
    const sent = await sendMessage(cdp, text.trim());
    return { sent };
  });
}

// 发简历请求(可选先切到会话)
async function chatResume(index) {
  return withChatPage(async (cdp) => {
    if (index != null) {
      const ok = await cdp.evaluate(`(() => {
        const el = document.querySelectorAll('.friend-content')[${index}];
        if (!el) return false;
        el.click(); return true;
      })()`);
      if (!ok) throw new Error(`会话索引越界: ${index}`);
      await sleep(1300);
    }
    const can = await canSendResume(cdp);
    if (!can) return { sent: false, detail: '「发简历」按钮当前不可用(需双方互动后)' };
    return await sendResumeRequest(cdp);
  });
}

// 清理 JD 文本:去掉 BOSS 反爬混入的 CSS 规则(.class{...})、干扰词(kanzhun/BOSS直聘)与多余空白
function cleanJd(jd) {
  return String(jd || '')
    .replace(/\.[A-Za-z][A-Za-z0-9_-]*\{[^{}]*\}/g, '')
    .replace(/kanzhun|zhipin|BOSS直聘|直聘/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // 静态页
    if (path === '/' || path === '/index.html') {
      const f = resolve(WEB_DIR, 'index.html');
      if (!existsSync(f)) { json(res, 404, { error: 'web/index.html 不存在' }); return; }
      const html = readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length });
      res.end(html);
      return;
    }

    // API
    if (req.method === 'GET') {
      if (path === '/api/stats') {
        const [stats, cdp] = await Promise.all([readStats(), cdpOnline()]);
        json(res, 200, {
          ...stats, cdpOnline: cdp,
          running: running ? running.label : null, runningCmd: running ? running.cmd : null,
          agentRunning: !!agentChild,
          chatLocked: chatLockReason(),
          schedulerEnabled: schedEnabled, nextCollectInMin: nextCollectInMin(),
          autoApplyEnabled, autoApplyMin,
          dailyLimit: _schedCfg.daily_limit ?? 50,
          lastCollectAt: getMeta('last_collect_at') ? new Date(Number(getMeta('last_collect_at'))).toLocaleString('zh-CN') : null,
        });
        return;
      }
      if (path === '/api/candidates') {
        const min = Number(url.searchParams.get('min') || 60);
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const per = Math.min(100, Math.max(5, Number(url.searchParams.get('per') || 15)));
        const rows = listCandidatesApi(min);
        const total = rows.length;
        const offset = (page - 1) * per;
        const items = rows.slice(offset, offset + per).map((r, i) => {
          const detail = JSON.parse(r.score_detail || '{}');
          const reason = briefReason({ job: r, similarity: detail.similarity, llm: detail.llm, mDetail: detail.match || {}, aDetail: detail.active || {} });
          return {
            id: offset + i, // 全局序号:与 dispatcher apply --ids 对应,跨页一致
            job_id: r.job_id, title: r.title, salary: r.salary,
            company: r.company, location: r.location, tags: JSON.parse(r.tags || '[]').slice(0, 5),
            total: r.total_score, match: r.match_score, active: r.active_score,
            boss_activity: r.boss_activity, reason, job_link: r.job_link,
            scoreMethod: r.score_method, similarity: detail.similarity?.score ?? null, llm: detail.llm || null,
            jd: cleanJd(r.jd),
          };
        });
        json(res, 200, { total, page, per, items });
        return;
      }
      if (path === '/api/applied') { json(res, 200, readApplied()); return; }
      if (path === '/api/hrstats') { json(res, 200, readHrStats()); return; }
      if (path === '/api/log') {
        const since = Number(url.searchParams.get('since') || 0);
        const lines = logBuf.filter((l) => l.i > since);
        json(res, 200, { lines, running: running ? running.label : null });
        return;
      }
      if (path === '/api/chat/sessions') {
        const lock = chatLockReason();
        if (lock) { json(res, 409, { error: lock }); return; }
        try { json(res, 200, await withChatLock(chatSessions)); }
        catch (e) { json(res, 500, { error: e.message }); }
        return;
      }
      if (path === '/api/agent/status') {
        json(res, 200, { ...agentStatus(), log: agentLog.slice(-60) });
        return;
      }
      if (path === '/api/resume') {
        try {
          const profile = JSON.parse(readFileSync(resolve(__dirname, 'resume_profile.json'), 'utf8'));
          json(res, 200, { resume_text: profile.resume_text || '', name: profile.name || '' });
        } catch (e) { json(res, 500, { error: e.message }); }
        return;
      }
      if (path === '/api/agent/sessions') {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const per = Math.min(100, Math.max(5, Number(url.searchParams.get('per') || 15)));
        openDb(DB_PATH);
        const total = countAiSessions();
        const rows = listAiSessions({ limit: per, offset: (page - 1) * per });
        closeDb();
        json(res, 200, { total, page, per, items: rows });
        return;
      }
    }

    if (req.method === 'POST' && path === '/api/resume') {
      const body = await readBody(req);
      try {
        const p = resolve(__dirname, 'resume_profile.json');
        const profile = JSON.parse(readFileSync(p, 'utf8'));
        profile.resume_text = String(body.resume_text || '').trim();
        writeFileSync(p, JSON.stringify(profile, null, 2), 'utf8');
        // 简历变更后,旧 LLM 缓存评分(基于旧简历)失效:清掉,重评分基于新简历
        try {
          const cleared = getDb().prepare("DELETE FROM candidates WHERE score_method='hybrid'").run().changes;
          logLine(`[简历] 简历文本已更新,清除 ${cleared} 条 LLM 缓存评分,需重新评分生效`);
        } catch {}
        json(res, 200, { ok: true, chars: profile.resume_text.length });
      } catch (e) { json(res, 500, { error: e.message }); }
      return;
    }

    if (req.method === 'POST' && path === '/api/scheduler') {
      const body = await readBody(req);
      schedEnabled = !!body.enabled;
      setMeta('sched_enabled', schedEnabled ? '1' : '0'); // 持久化
      if (schedEnabled) lastCollectAt = Date.now(); // 开启后从当下计时
      logLine(`[调度] 自动采集${schedEnabled ? '已开启' : '已关闭'}(间隔 ${schedIntervalMin} 分钟)`);
      json(res, 200, { enabled: schedEnabled, intervalMin: schedIntervalMin, nextCollectInMin: nextCollectInMin() });
      return;
    }
    if (req.method === 'POST' && path === '/api/autoapply') {
      const body = await readBody(req);
      autoApplyEnabled = !!body.enabled;
      setMeta('autoapply_enabled', autoApplyEnabled ? '1' : '0'); // 持久化
      logLine(`[调度] 自动投递${autoApplyEnabled ? `已开启(≥${autoApplyMin}分,受每日上限${_schedCfg.daily_limit || 20}约束)` : '已关闭'}`);
      json(res, 200, { enabled: autoApplyEnabled, minScore: autoApplyMin });
      return;
    }

    if (req.method === 'POST' && path === '/api/agent/start') {
      const r = startAgent();
      if (r.ok) logLine('[面板] AI 代理已启动');
      else logLine(`[面板] AI 代理启动失败: ${r.error || ''}`);
      json(res, r.ok ? 200 : 409, r);
      return;
    }
    if (req.method === 'POST' && path === '/api/agent/stop') {
      const r = stopAgent();
      if (r.ok) logLine('[面板] AI 代理已停止');
      json(res, r.ok ? 200 : 409, r);
      return;
    }

    if (req.method === 'POST' && path.startsWith('/api/chat/')) {
      const lock = chatLockReason();
      if (lock) { json(res, 409, { error: lock }); return; }
      const body = await readBody(req);
      try {
        if (path === '/api/chat/open') {
          const r = await withChatLock(() => chatOpen(Number(body.index)));
          logLine(`[面板] 打开会话 #${body.index} → ${(r?.chatInfo?.chat || '').slice(0, 40) || (r?.messages?.length != null ? `${r.messages.length} 条消息` : 'OK')}`);
          json(res, 200, r); return;
        }
        if (path === '/api/chat/send') {
          const r = await withChatLock(() => chatSend(body.index != null ? Number(body.index) : null, String(body.text || '')));
          logLine(`[面板] 发消息${body.index != null ? ` #会话${body.index}` : '(当前会话)'}: ${String(body.text || '').slice(0, 30)} → ${r?.sent ? '已发送' : '失败'}`);
          json(res, 200, r); return;
        }
        if (path === '/api/chat/resume') {
          const r = await withChatLock(() => chatResume(body.index != null ? Number(body.index) : null));
          logLine(`[面板] 发简历${body.index != null ? ` #会话${body.index}` : '(当前会话)'} → ${r?.sent ? '已发送' : (r?.detail || '失败')}`);
          json(res, 200, r); return;
        }
      } catch (e) { json(res, 500, { error: e.message }); return; }
    }

    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      const cmd = body.cmd;
      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      if (!['collect', 'score', 'feedback', 'apply'].includes(cmd)) {
        json(res, 400, { error: `未知命令: ${cmd}` });
        return;
      }
      const r = runTask(cmd, args);
      json(res, r.ok ? 200 : 409, { ok: r.ok, error: r.error });
      return;
    }

    json(res, 404, { error: 'Not Found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// 加载历史日志(服务器重启后保留),并收敛日志文件
loadLogFile(PANEL_LOG, logBuf, 400);
loadLogFile(AGENT_LOG, agentLog, 400);
try { writeFileSync(PANEL_LOG, logBuf.map((e) => `${e.ts}|${e.line}`).join('\n') + '\n', 'utf8'); } catch {}
try { writeFileSync(AGENT_LOG, agentLog.map((e) => `${e.ts}|${e.line}`).join('\n') + '\n', 'utf8'); } catch {}

// 端口被占用时自动顺延(最多 +10),避免 EADDRINUSE 崩溃
// 单 error 监听 + 单 listening 监听,避免重复横幅 / 错误端口 / 运行期误杀
const PORT_START = PORT;
const HOST = '127.0.0.1'; // 仅本机访问,防局域网他人读写/触发真实投递
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && PORT < PORT_START + 10) {
    PORT += 1;
    console.warn(`[server] 端口被占用,改用 ${PORT}…`);
    server.listen(PORT, HOST);
  } else {
    console.error(`[server] 启动失败: ${err.message}`);
    process.exit(1);
  }
});
server.once('listening', () => {
  const p = server.address().port;
  console.log(`\n自动投递管理面板: http://localhost:${p}`);
  console.log(`CDP 调试端口: ${CDP_PORT}`);
  console.log(`数据库: ${DB_PATH}\n`);
  console.log('功能: 采集 / 评分 / 候选投递 / 反馈 / 日志');
  console.log('按 Ctrl+C 停止服务(不影响浏览器)。\n');
  // 无人监管:若此前运行过 AI 助手(meta)或配置开启,启动时自动恢复
  const agentShouldRun = getMeta('agent_enabled') === '1' || _schedCfg.agent?.enabled;
  if (agentShouldRun) {
    setTimeout(() => { startAgent(); }, 3000);
  }
});
server.listen(PORT, HOST);
