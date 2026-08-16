// storage.mjs — SQLite 数据层(零依赖,node:sqlite)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db = null;
let dbPath = 'data/apply.db'; // 记录已打开路径,getDb 复用同一条,避免分叉

export function openDb(p = 'data/apply.db') {
  dbPath = p;
  if (p === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    const full = resolve(__dirname, p);
    mkdirSync(dirname(full), { recursive: true });
    db = new DatabaseSync(full);
  }
  db.exec('PRAGMA journal_mode = WAL;');
  initTables();
  return db;
}

export function getDb() {
  if (!db) openDb(dbPath);
  return db;
}

export function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id         TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      salary         TEXT,
      tags           TEXT,
      company        TEXT,
      location       TEXT,
      job_link       TEXT,
      jd             TEXT,
      publish_time   TEXT,
      is_urgent      INTEGER DEFAULT 0,
      boss_activity  TEXT,               -- 面板 HR 活跃度原文(如「3日内活跃」)
      search_keyword TEXT,
      search_page    INTEGER,            -- 采集时所在搜索词的第几页(投递时直达,免翻页)
      security_id    TEXT,               -- 岗位 securityId(调 add.json 直接发起会话,免找卡片)
      fetched_at     TEXT DEFAULT (datetime('now','localtime')),
      jd_fetched     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_fetched ON jobs(fetched_at);

    CREATE TABLE IF NOT EXISTS candidates (
      job_id       TEXT PRIMARY KEY REFERENCES jobs(job_id),
      match_score  REAL,
      active_score REAL,
      total_score  REAL,
      score_method TEXT DEFAULT 'rule',
      score_detail TEXT,
      scored_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS applied (
      job_id         TEXT PRIMARY KEY REFERENCES jobs(job_id),
      title          TEXT,
      company        TEXT,
      total_score    REAL,
      greeted_at     TEXT,
      msg_sent_at    TEXT,
      resume_req_at  TEXT,
      reply_at       TEXT,
      reply_delay_sec INTEGER,
      status         TEXT DEFAULT 'pending',
      created_at     TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS hr_stats (
      boss_key       TEXT PRIMARY KEY,
      company        TEXT,
      contact        TEXT,
      first_seen_at  TEXT DEFAULT (datetime('now','localtime')),
      last_active_at TEXT DEFAULT (datetime('now','localtime')),
      reply_count    INTEGER DEFAULT 0,
      avg_reply_sec  INTEGER,
      min_reply_sec  INTEGER,
      last_reply_at  TEXT            -- 最近一次已计数的回复时间(去重)
    );

    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    -- AI 对话代理状态(每会话一行,last_mid 追踪已处理消息)
    CREATE TABLE IF NOT EXISTS ai_sessions (
      session_key    TEXT PRIMARY KEY,   -- company·contact 稳定标识
      company        TEXT,
      contact        TEXT,
      job_id         TEXT,
      status         TEXT DEFAULT 'active',  -- active|rejected|resume_sent|interview|closed
      reject_reason  TEXT,
      last_mid       TEXT,               -- 已处理的最大消息 id(data-mid)
      last_reply_at  TEXT,
      last_ai_action TEXT,               -- 最近一次 AI 动作摘要
      last_ai_at     TEXT,
      history        TEXT,               -- JSON 数组:决策记录
      updated_at     TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_status ON ai_sessions(status);
  `);
  // 兼容已存在的旧库:缺失的列补上(新库由上方 CREATE 直接创建)
  for (const col of ['boss_activity TEXT', 'last_reply_at TEXT', 'search_page INTEGER', 'security_id TEXT']) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch {}
    try { db.exec(`ALTER TABLE hr_stats ADD COLUMN ${col}`); } catch {}
  }
  // applied.created_at:ADD COLUMN 不允许非常量 DEFAULT,故先加无默认列再回填
  try {
    db.exec('ALTER TABLE applied ADD COLUMN created_at TEXT');
    db.exec("UPDATE applied SET created_at = COALESCE(greeted_at, datetime('now','localtime')) WHERE created_at IS NULL");
  } catch {}
}

// ---------- jobs ----------
export function upsertJob(job) {
  const d = getDb();
  const j = {
    job_id: job.job_id,
    title: job.title ?? null,
    salary: job.salary ?? null,
    tags: job.tags ? JSON.stringify(job.tags) : null,
    company: job.company ?? null,
    location: job.location ?? null,
    job_link: job.job_link ?? null,
    jd: job.jd ?? null,
    publish_time: job.publish_time ?? null,
    is_urgent: job.is_urgent ? 1 : 0,
    boss_activity: job.boss_activity ?? null,
    search_keyword: job.search_keyword ?? null,
    search_page: job.search_page ?? null,
    security_id: job.security_id ?? null,
    jd_fetched: job.jd_fetched ? 1 : 0,
  };
  d.prepare(`
    INSERT INTO jobs (job_id, title, salary, tags, company, location, job_link, jd, publish_time, is_urgent, boss_activity, search_keyword, search_page, security_id, jd_fetched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      title=excluded.title, salary=excluded.salary, tags=excluded.tags,
      company=excluded.company, location=excluded.location,
      jd=COALESCE(excluded.jd, jobs.jd),
      publish_time=COALESCE(excluded.publish_time, jobs.publish_time),
      is_urgent=excluded.is_urgent,
      boss_activity=COALESCE(excluded.boss_activity, jobs.boss_activity),
      search_keyword=COALESCE(excluded.search_keyword, jobs.search_keyword),
      search_page=COALESCE(excluded.search_page, jobs.search_page),
      security_id=COALESCE(excluded.security_id, jobs.security_id),
      jd_fetched=MAX(jobs.jd_fetched, excluded.jd_fetched)
  `).run(
    j.job_id, j.title, j.salary, j.tags,
    j.company, j.location, j.job_link, j.jd,
    j.publish_time, j.is_urgent, j.boss_activity, j.search_keyword, j.search_page, j.security_id, j.jd_fetched
  );
}

export function jobExists(jobId) {
  return !!getDb().prepare('SELECT 1 FROM jobs WHERE job_id=?').get(jobId);
}

// 定向更新岗位的单个字段(不覆盖其它列)
export function updateJobField(jobId, fields) {
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined)
    .map(([k]) => `${k}=?`).join(', ');
  if (!sets) return;
  const vals = Object.entries(fields).filter(([, v]) => v !== undefined).map(([, v]) => v);
  getDb().prepare(`UPDATE jobs SET ${sets} WHERE job_id=?`).run(...vals, jobId);
}

// 需要抓详情页的岗位(列表页已入但 jd 未抓)
export function getPendingDetailJobs(limit = 500) {
  return getDb().prepare(`
    SELECT * FROM jobs WHERE jd_fetched=0 ORDER BY fetched_at DESC LIMIT ?
  `).all(limit);
}

export function getJob(jobId) {
  return getDb().prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId);
}

export function listJobs({ limit = 200 } = {}) {
  return getDb().prepare('SELECT * FROM jobs ORDER BY fetched_at DESC LIMIT ?').all(limit);
}

export function countJobs() {
  return getDb().prepare('SELECT COUNT(*) c FROM jobs').get().c;
}

// ---------- candidates ----------
export function upsertCandidate(c) {
  getDb().prepare(`
    INSERT INTO candidates (job_id, match_score, active_score, total_score, score_method, score_detail, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(job_id) DO UPDATE SET
      match_score=excluded.match_score, active_score=excluded.active_score,
      total_score=excluded.total_score, score_method=excluded.score_method,
      score_detail=excluded.score_detail, scored_at=excluded.scored_at
  `).run(c.job_id, c.match_score, c.active_score, c.total_score, c.score_method, c.score_detail || null);
}

// 未投递岗位的评分清单(总分降序),可过滤分数阈值
export function listCandidates({ minScore = 0, excludeApplied = true, limit = 100 } = {}) {
  const d = getDb();
  // excludeApplied:排除已投,但「过期 pending 占位」视为未投(允许重试)
  const appliedJoin = excludeApplied
    ? `LEFT JOIN applied a ON a.job_id = j.job_id WHERE (a.job_id IS NULL OR (a.status='pending' AND a.created_at <= datetime('now','localtime','-10 minutes')))`
    : 'WHERE 1=1';
  return d.prepare(`
    SELECT j.*, c.match_score, c.active_score, c.total_score, c.score_method, c.score_detail
    FROM candidates c JOIN jobs j ON j.job_id = c.job_id
    ${appliedJoin} AND c.total_score >= ?
    ORDER BY c.total_score DESC
    LIMIT ?
  `).all(minScore, limit);
}

// ---------- applied ----------
export function insertApplied(a) {
  getDb().prepare(`
    INSERT OR IGNORE INTO applied (job_id, title, company, total_score, greeted_at, msg_sent_at, resume_req_at, reply_at, reply_delay_sec, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.job_id, a.title ?? null, a.company ?? null, a.total_score ?? null,
    a.greeted_at || null, a.msg_sent_at || null, a.resume_req_at || null,
    a.reply_at || null, a.reply_delay_sec ?? null, a.status || 'pending'
  );
}

export function updateApplied(jobId, fields) {
  const d = getDb();
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined)
    .map(([k]) => `${k}=?`).join(', ');
  if (!sets) return;
  const vals = Object.entries(fields).filter(([, v]) => v !== undefined).map(([, v]) => v);
  d.prepare(`UPDATE applied SET ${sets} WHERE job_id=?`).run(...vals, jobId);
}

export function getApplied(jobId) {
  return getDb().prepare('SELECT * FROM applied WHERE job_id=?').get(jobId);
}

// 仅删除"无任何实际动作"的 pending 占位行(打招呼失败且未发出时释放,允许重试)
export function deleteApplied(jobId) {
  getDb().prepare('DELETE FROM applied WHERE job_id=? AND status=?').run(jobId, 'pending');
}

// 是否已投:存在非「过期 pending 占位」的记录即视为已投
// (过期 pending = 打招呼前崩溃残留,超10分钟允许重试,避免永久吞掉岗位)
export function isApplied(jobId) {
  const row = getDb().prepare(`
    SELECT 1 FROM applied
    WHERE job_id=? AND NOT (status='pending' AND created_at <= datetime('now','localtime','-10 minutes'))
  `).get(jobId);
  return !!row;
}

export function listApplied({ limit = 100 } = {}) {
  return getDb().prepare('SELECT * FROM applied ORDER BY greeted_at DESC LIMIT ?').all(limit);
}

// 今天已打招呼数量(按本地日界,greeted_at 存 UTC 需转 localtime 再比)
export function countAppliedToday() {
  const row = getDb().prepare(`
    SELECT COUNT(*) c FROM applied
    WHERE greeted_at IS NOT NULL AND date(datetime(greeted_at, 'localtime')) = date('now','localtime')
  `).get();
  return row.c;
}

// ---------- hr_stats ----------
// stat.last_reply_at(ISO)用于去重:仅当该回复时间比已记录的新才累加 reply_count
export function upsertHrStat(stat) {
  const d = getDb();
  const old = d.prepare('SELECT * FROM hr_stats WHERE boss_key=?').get(stat.boss_key);
  const isNewReply = stat.add_reply && !(old && old.last_reply_at && stat.last_reply_at && stat.last_reply_at <= old.last_reply_at);
  if (!old) {
    d.prepare(`
      INSERT INTO hr_stats (boss_key, company, contact, first_seen_at, last_active_at, reply_count, avg_reply_sec, min_reply_sec, last_reply_at)
      VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'), ?, ?, ?, ?)
    `).run(
      stat.boss_key, stat.company || null, stat.contact || null,
      stat.reply_count || 0, stat.avg_reply_sec || null, stat.min_reply_sec || null,
      isNewReply ? (stat.last_reply_at || null) : null
    );
  } else {
    const replyCount = (old.reply_count || 0) + (isNewReply ? 1 : 0);
    // 仅把新回复的延迟并入平均
    const delays = [];
    if (old.avg_reply_sec != null && old.reply_count) delays.push(old.avg_reply_sec * old.reply_count);
    if (isNewReply && stat.avg_reply_sec != null) delays.push(stat.avg_reply_sec * 1);
    const avg = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / Math.max(1, replyCount)) : (isNewReply ? stat.avg_reply_sec : null);
    const minSec = isNewReply && stat.min_reply_sec != null
      ? (old.min_reply_sec == null ? stat.min_reply_sec : Math.min(old.min_reply_sec, stat.min_reply_sec))
      : old.min_reply_sec;
    d.prepare(`
      UPDATE hr_stats SET
        company=COALESCE(?, company), contact=COALESCE(?, contact),
        last_active_at=datetime('now','localtime'),
        reply_count=?, avg_reply_sec=?, min_reply_sec=?, last_reply_at=?
      WHERE boss_key=?
    `).run(stat.company || null, stat.contact || null, replyCount, avg, minSec, (isNewReply && stat.last_reply_at) ? stat.last_reply_at : old.last_reply_at, stat.boss_key);
  }
}

export function getHrStat(bossKey) {
  return getDb().prepare('SELECT * FROM hr_stats WHERE boss_key=?').get(bossKey);
}

export function listHrStats() {
  return getDb().prepare('SELECT * FROM hr_stats').all();
}

// ---------- meta ----------
export function setMeta(k, v) {
  getDb().prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, String(v));
}

export function getMeta(k) {
  const r = getDb().prepare('SELECT v FROM meta WHERE k=?').get(k);
  return r ? r.v : null;
}

// ---------- ai_sessions(AI 对话代理) ----------
export function upsertAiSession(s) {
  const d = getDb();
  const old = d.prepare('SELECT * FROM ai_sessions WHERE session_key=?').get(s.session_key);
  const history = [];
  if (old?.history) { try { history.push(...JSON.parse(old.history)); } catch {} }
  if (s.push) history.push(s.push);
  if (history.length > 60) history.splice(0, history.length - 60);
  d.prepare(`
    INSERT INTO ai_sessions (session_key, company, contact, job_id, status, reject_reason, last_mid, last_reply_at, last_ai_action, last_ai_at, history, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, datetime('now','localtime'))
    ON CONFLICT(session_key) DO UPDATE SET
      company=COALESCE(excluded.company, ai_sessions.company),
      contact=COALESCE(excluded.contact, ai_sessions.contact),
      job_id=COALESCE(excluded.job_id, ai_sessions.job_id),
      status=excluded.status,
      reject_reason=excluded.reject_reason,
      last_mid=excluded.last_mid,
      last_reply_at=excluded.last_reply_at,
      last_ai_action=excluded.last_ai_action,
      last_ai_at=excluded.last_ai_at,
      history=excluded.history,
      updated_at=datetime('now','localtime')
  `).run(
    s.session_key, s.company ?? null, s.contact ?? null, s.job_id ?? null,
    s.status ?? 'active', s.reject_reason ?? null, s.last_mid ?? null,
    s.last_reply_at ?? null, s.last_ai_action ?? null, JSON.stringify(history)
  );
}

export function getAiSession(sessionKey) {
  return getDb().prepare('SELECT * FROM ai_sessions WHERE session_key=?').get(sessionKey);
}

export function listAiSessions({ status = null, limit = 200, offset = 0 } = {}) {
  if (status) return getDb().prepare('SELECT * FROM ai_sessions WHERE status=? ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(status, limit, offset);
  return getDb().prepare('SELECT * FROM ai_sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function countAiSessions() {
  return getDb().prepare('SELECT COUNT(*) c FROM ai_sessions').get().c;
}
