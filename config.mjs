// config.mjs — 配置与简历画像加载(零依赖)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  db_path: 'data/apply.db',
  search_keywords: ['Python', '全栈工程师', 'PHP', '后端'],
  pages_per_keyword: 3,
  city_code: '101280600',
  daily_limit: 50,
  score_threshold: 60,
  min_interval_sec: 60,
  max_interval_sec: 120,
  weight_match: 0.7,
  weight_active: 0.3,
  hard_exclude: true,
  pause_on_captcha: true,
  detail_fetch_interval_sec: 3,
  greeting_message: '您好，我是有三年经验的 FDE 全栈工程师，请问可以发您一份我的简历吗？',
  llm: {
    enabled: false,
    api_key: '',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  agent: {
    enabled: false,          // 面板「AI 助手」启动开关
    interval_sec: 90,        // 监听扫描间隔
    min_action_delay_sec: 8, // 动作间随机延迟下限(防风控)
    max_action_delay_sec: 25,
    quiet_hours: [0, 8],     // 夜间静默时段(小时),不打扰 HR
    persona: '你是侯皓展(三年经验 FDE 全栈工程师,前后端+Python+PHP,大专学历)的求职助手,代替 TA 与招聘方在 BOSS 直聘上对话。',
  },
  scheduler: {
    enabled: false,          // 定时自动采集开关(面板可开)
    collect_interval_min: 60,// 自动采集+评分的间隔(分钟)
  },
  auto_apply: {
    enabled: false,          // 评分≥min_score 自动投递(真实打招呼,默认关)
    min_score: 70,           // 自动投递分数阈值
  },
  score_blend: {
    similarity: 0.4,         // 相似度算法权重
    llm: 0.6,                // AI 辅助权重(验证显示 LLM 更准)
  },
};

// 校验配置对象(可独立测试);配置错误时回退默认值并收集告警,不崩溃
export function validateConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const warnings = [];

  const num = (v, def, min, max) => {
    if (v == null || v === '' || typeof v === 'boolean') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const arr = (v, def) => (Array.isArray(v) && v.length ? [...v] : [...def]);
  const str = (v, def) => (typeof v === 'string' && v.trim() ? v.trim() : def);
  const normWeights = (a, b, defA, defB) => {
    const s = a + b;
    if (s <= 0) return [defA, defB];
    return [a / s, b / s];
  };

  const searchKeywords = (Array.isArray(raw.search_keywords) ? raw.search_keywords : DEFAULTS.search_keywords)
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim());
  if (!searchKeywords.length) { warnings.push('search_keywords 无效,使用默认'); }

  const quietHours = (Array.isArray(raw.agent?.quiet_hours) ? raw.agent.quiet_hours : DEFAULTS.agent.quiet_hours)
    .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  if (quietHours.length !== 2 || quietHours[0] === quietHours[1]) {
    warnings.push('agent.quiet_hours 需为两个不同的小时(0-23),使用默认');
    quietHours.splice(0, quietHours.length, ...DEFAULTS.agent.quiet_hours);
  }

  const cfg = {
    search_keywords: searchKeywords,
    pages_per_keyword: num(raw.pages_per_keyword, DEFAULTS.pages_per_keyword, 1, 10),
    city_code: str(raw.city_code, DEFAULTS.city_code),
    daily_limit: num(raw.daily_limit, DEFAULTS.daily_limit, 1, 200),
    score_threshold: num(raw.score_threshold, DEFAULTS.score_threshold, 0, 100),
    min_interval_sec: num(raw.min_interval_sec, DEFAULTS.min_interval_sec, 5, 600),
    max_interval_sec: num(raw.max_interval_sec, DEFAULTS.max_interval_sec, 5, 600),
    hard_exclude: bool(raw.hard_exclude, DEFAULTS.hard_exclude),
    pause_on_captcha: bool(raw.pause_on_captcha, DEFAULTS.pause_on_captcha),
    detail_fetch_interval_sec: num(raw.detail_fetch_interval_sec, DEFAULTS.detail_fetch_interval_sec, 1, 30),
    greeting_message: str(raw.greeting_message, DEFAULTS.greeting_message),
    db_path: str(raw.db_path, DEFAULTS.db_path || 'data/apply.db'),
  };
  if (cfg.max_interval_sec < cfg.min_interval_sec) cfg.max_interval_sec = cfg.min_interval_sec;
  [cfg.weight_match, cfg.weight_active] = normWeights(
    num(raw.weight_match, 0.7, 0, 1), num(raw.weight_active, 0.3, 0, 1), 0.7, 0.3
  );

  cfg.llm = {
    enabled: bool(raw.llm?.enabled, DEFAULTS.llm.enabled),
    api_key: str(raw.llm?.api_key, DEFAULTS.llm.api_key),
    base_url: str(raw.llm?.base_url, DEFAULTS.llm.base_url),
    model: str(raw.llm?.model, DEFAULTS.llm.model),
  };
  cfg.agent = {
    enabled: bool(raw.agent?.enabled, DEFAULTS.agent.enabled),
    interval_sec: num(raw.agent?.interval_sec, DEFAULTS.agent.interval_sec, 10, 3600),
    min_action_delay_sec: num(raw.agent?.min_action_delay_sec, DEFAULTS.agent.min_action_delay_sec, 1, 120),
    max_action_delay_sec: num(raw.agent?.max_action_delay_sec, DEFAULTS.agent.max_action_delay_sec, 1, 120),
    quiet_hours: quietHours,
    persona: str(raw.agent?.persona, DEFAULTS.agent.persona),
  };
  if (cfg.agent.max_action_delay_sec < cfg.agent.min_action_delay_sec) cfg.agent.max_action_delay_sec = cfg.agent.min_action_delay_sec;

  cfg.scheduler = {
    enabled: bool(raw.scheduler?.enabled, DEFAULTS.scheduler.enabled),
    collect_interval_min: num(raw.scheduler?.collect_interval_min, DEFAULTS.scheduler.collect_interval_min, 5, 1440),
  };
  cfg.auto_apply = {
    enabled: bool(raw.auto_apply?.enabled, DEFAULTS.auto_apply.enabled),
    min_score: num(raw.auto_apply?.min_score, DEFAULTS.auto_apply.min_score, 0, 100),
  };
  cfg.score_blend = {};
  [cfg.score_blend.similarity, cfg.score_blend.llm] = normWeights(
    num(raw.score_blend?.similarity, 0.4, 0, 1), num(raw.score_blend?.llm, 0.6, 0, 1), 0.4, 0.6
  );

  // 未知顶层 key 提示拼写错误
  const known = ['search_keywords', 'pages_per_keyword', 'city_code', 'daily_limit', 'score_threshold', 'min_interval_sec', 'max_interval_sec', 'weight_match', 'weight_active', 'hard_exclude', 'pause_on_captcha', 'detail_fetch_interval_sec', 'greeting_message', 'db_path', 'llm', 'agent', 'scheduler', 'auto_apply', 'score_blend'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) warnings.push(`未知配置项「${k}」(检查拼写)`);

  if (warnings.length) console.warn(`[config] ${warnings.join('; ')}`);
  return cfg;
}

// 读取并校验 config.json;读取失败回退默认,不崩溃
export function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(resolve(__dirname, 'config.json'), 'utf8'));
  } catch (e) {
    console.warn(`[config] 读取 config.json 失败(${e.message}),使用默认配置。`);
  }
  return validateConfig(raw);
}

export function loadResumeProfile() {
  try {
    const p = JSON.parse(readFileSync(resolve(__dirname, 'resume_profile.json'), 'utf8'));
    if (!p || typeof p !== 'object') throw new Error('结构无效');
    return p;
  } catch (e) {
    throw new Error(`简历画像 resume_profile.json 读取失败: ${e.message}`);
  }
}
