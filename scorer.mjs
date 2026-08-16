// scorer.mjs — 评分层:规则评分(可解释)+ 可选 LLM 增强,结果入库 candidates
// 纯函数 API(tests/scorer.test.mjs 直接测试):
//   parseYears / parseEdu / parsePublishAge
//   computeMatchScore / computeActiveScore / computeTotal
// 上层封装:
//   scoreJob(job, cfg, profile)   单个岗位评分(不写库)
//   runScoring(opt)               对库中岗位评分入库并输出清单
//   briefReason(r)                一句话可解释理由
//
// 评分模型(见 DESIGN.md §5):
//   match_score = 标题40% + 标签30% + JD30%(命中 exclude 则归零)
//   active_score= 新鲜度40%(publish_time 或 boss_activity)+ 急聘20% + 历史回复速度40%,未知信号自动归一
//   total = match*W_MATCH + active*W_ACTIVE
import { loadConfig, loadResumeProfile } from './config.mjs';
import { openDb, closeDb, listJobs, getJob, upsertCandidate, getHrStat, getDb } from './storage.mjs';

// ---------- 基础解析 ----------
// 从 tags(数组或字符串)解析年限要求:{ min, max } 或 null
export function parseYears(input) {
  const text = (Array.isArray(input) ? input.join(' ') : (input || '')).toLowerCase();
  let m;
  if ((m = text.match(/(\d+)\s*年以上/))) return { min: +m[1], max: 99 };
  if ((m = text.match(/(\d+)\s*[-~]\s*(\d+)\s*年/))) return { min: +m[1], max: +m[2] };
  if ((m = text.match(/(\d+)\s*年/))) return { min: +m[1], max: +m[1] };
  if (/经验不限|不限/.test(text)) return { min: 0, max: 1 };
  return null;
}

// 清理 JD 文本:去掉 BOSS 反爬混入的 CSS 规则、干扰词(kanzhun/BOSS直聘)与多余空白
function cleanJd(jd) {
  return String(jd || '')
    .replace(/\.[A-Za-z][A-Za-z0-9_-]*\{[^{}]*\}/g, '')
    .replace(/kanzhun|zhipin|BOSS直聘|直聘/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 学历要求:{ level, label },level 越高越严(大专2/本科3/硕士4/博士5/学历不限6)
export function parseEdu(input) {
  const text = (Array.isArray(input) ? input.join(' ') : (input || '')).toLowerCase();
  if (/学历不限|不限学历/.test(text)) return { level: 6, label: '学历不限' };
  if (/博士/.test(text)) return { level: 5, label: '博士' };
  if (/硕士|研究生/.test(text)) return { level: 4, label: '硕士' };
  if (/本科/.test(text)) return { level: 3, label: '本科' };
  if (/大专/.test(text)) return { level: 2, label: '大专' };
  return null;
}

// 解析发布时间文本为「距今天数」。未知返回 { known: false }。
// 支持:刚刚 / N天前 / N小时前 / N分钟前 / YYYY-MM-DD / 今天 / 长期
export function parsePublishAge(text, now = Date.now()) {
  text = (text || '').trim().toLowerCase();
  if (!text || /长期|未知/.test(text)) return { known: false, days: null };
  let m;
  if (/刚刚/.test(text) || text === '今天' || text === '今日') return { known: true, days: 0 };
  if ((m = text.match(/(\d+)\s*天前/))) return { known: true, days: +m[1] };
  if ((m = text.match(/(\d+)\s*小时前/))) return { known: true, days: Math.round((+m[1] / 24) * 1000) / 1000 };
  if ((m = text.match(/(\d+)\s*分钟前/))) return { known: true, days: Math.round((+m[1] / 1440) * 1000) / 1000 };
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return { known: true, days: Math.floor((now - t) / 86400000) };
  }
  if ((m = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/))) {
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return { known: true, days: Math.floor((now - t) / 86400000) };
  }
  return { known: false, days: null };
}

// ---------- 岗位匹配分 ----------
export function computeMatchScore(job, profile, opts = {}) {
  const hardExclude = opts.hardExclude ?? true;
  const detail = { excluded: [], title: {}, tags: {}, jd: {} };
  const S = (v) => String(v ?? ''); // 防御异常类型(数字/null等)
  const title = S(job.title).toLowerCase();
  const tags = (Array.isArray(job.tags) ? job.tags : []).map(S);
  const tagText = tags.join(' ').toLowerCase();
  const jdText = S(job.jd).toLowerCase();
  const skillKeys = Object.keys(profile.skills || {});

  // 排除词(修复误判):仅标题/标签命中或强条件词命中才硬性归零;
  // JD 里偶然提及(如「平台运营」「客服系统」「不包吃住」)只软扣分。
  const ROLE_EXCLUDES = new Set(['销售', '运营', '客服', '模具', 'cnc', '门店', '主播', '保安', '文员', '导购', '普工']);
  const COND_EXCLUDES = new Set(['两班倒', '包吃住']);
  const strongExcluded = [];
  const weakExcluded = [];
  for (const k of profile.exclude_keywords || []) {
    if (!k) continue;
    const nk = k.toLowerCase();
    const inTitleTags = title.includes(nk) || tagText.includes(nk);
    const inJd = jdText.includes(nk);
    // JD 中出现但被否定(如「不包吃住」)→ 不算
    const negated = inJd && new RegExp(`(不|非|无|没有|不提供|不含)${nk}`).test(jdText);
    if (inTitleTags) {
      strongExcluded.push(k);
    } else if (inJd && !negated) {
      if (COND_EXCLUDES.has(k.toLowerCase()) || !ROLE_EXCLUDES.has(k.toLowerCase())) strongExcluded.push(k);
      else weakExcluded.push(k);
    }
  }
  const excluded = strongExcluded.concat(weakExcluded);
  if (excluded.length) {
    detail.excluded = excluded;
    if (strongExcluded.length && hardExclude) return { score: 0, detail };
  }

  // 1) 标题关键词 40%
  const roleHits = (profile.preferred_roles || []).filter((r) => r && title.includes(r.toLowerCase()));
  const titleSkillHits = skillKeys.filter((k) => title.includes(k.toLowerCase()));
  let titleScore;
  if (roleHits.length) titleScore = Math.min(100, 50 + roleHits.length * 25);
  else if (titleSkillHits.length) titleScore = Math.min(60, 30 + titleSkillHits.length * 15);
  else titleScore = 10;
  detail.title = { role_hits: roleHits, skill_hits: titleSkillHits, score: titleScore };

  // 2) 标签匹配 30%(年限40% + 学历30% + 技能30%)
  const years = parseYears(tags);
  let yearsScore = 60;
  if (years) {
    const exp = profile.years_experience;
    if (exp >= years.min) yearsScore = 100;
    else if (years.min - exp <= 1) yearsScore = 80;
    else if (years.min - exp <= 3) yearsScore = 60;
    else yearsScore = 30;
  }
  detail.tags.years = { req: years, score: yearsScore };

  const edu = parseEdu(tags);
  let eduScore = 100;
  if (edu) {
    const myLevel = (parseEdu([profile.education]) || { level: 3 }).level;
    if (edu.level >= 6) eduScore = 100;
    else if (myLevel >= edu.level) eduScore = 100;
    else if (myLevel === edu.level - 1) eduScore = 70;
    else eduScore = 40;
  }
  detail.tags.edu = { req: edu, score: eduScore };

  const tagSkillHits = skillKeys.filter((k) => tagText.includes(k.toLowerCase()));
  const tagSkillScore = tagSkillHits.length ? Math.min(100, 30 + tagSkillHits.length * 20) : 20;
  detail.tags.skill = { hits: tagSkillHits, score: tagSkillScore };
  const tagsScore = Math.round(yearsScore * 0.4 + eduScore * 0.3 + tagSkillScore * 0.3);
  detail.tags.score = tagsScore;

  // 3) JD 描述 30%:技能词加权出现次数,按画像前5技能归一
  let jdWeighted = 0;
  const jdHits = [];
  for (const [k, lv] of Object.entries(profile.skills || {})) {
    const nk = k.toLowerCase();
    if (jdText.includes(nk)) {
      const count = (jdText.match(new RegExp(nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      jdWeighted += lv * Math.min(count, 3);
      jdHits.push({ skill: k, level: lv, count });
    }
  }
  const topLevels = Object.values(profile.skills || {}).sort((a, b) => b - a).slice(0, 5);
  const expected = topLevels.reduce((a, b) => a + b, 0);
  const jdScore = expected ? Math.round(Math.min(100, (jdWeighted / expected) * 100)) : 0;

  if (job.jd) {
    detail.jd = { hits: jdHits, weighted: jdWeighted, expected, score: jdScore };
  } else {
    detail.jd = { score: null }; // 无 JD 时该维度自动归一(用中性 50)
  }

  let score = Math.round(titleScore * 0.4 + tagsScore * 0.3 + (detail.jd.score ?? 50) * 0.3);
  if (weakExcluded.length) score = Math.max(0, score - 20); // JD 偶然提及角色类排除词:软扣分
  if (excluded.length && !hardExclude) score = Math.max(0, score - 30);
  return { score, detail };
}

// ---------- 相似度算法(量化 JD ↔ 简历重叠度,纯规则不调 LLM) ----------
export function computeSimilarity(job, profile) {
  const S = (v) => String(v ?? '');
  const title = S(job.title).toLowerCase();
  const tags = (Array.isArray(job.tags) ? job.tags : []).map(S);
  const tagText = tags.join(' ').toLowerCase();
  const jdText = S(job.jd).toLowerCase();
  const allText = `${title} ${tagText} ${jdText}`;
  const skills = profile.skills || {};

  // 标题角色命中(岗位方向是否对口)
  const roleHits = (profile.preferred_roles || []).filter((r) => r && title.includes(r.toLowerCase()));

  // 技能命中(标题+标签+JD),按画像技能权重累加
  const hits = [];
  let weighted = 0;
  for (const [k, lv] of Object.entries(skills)) {
    const nk = k.toLowerCase();
    if (allText.includes(nk)) { hits.push(k); weighted += lv; }
  }
  const top5 = Object.values(skills).sort((a, b) => b - a).slice(0, 5);
  const maxW = top5.reduce((a, b) => a + b, 0);
  const skillScore = maxW ? Math.round(Math.min(100, (weighted / maxW) * 100)) : 0;
  const roleScore = roleHits.length ? Math.min(100, 50 + roleHits.length * 25) : 0;

  const score = Math.round(skillScore * 0.7 + roleScore * 0.3);
  return { score, hits, roleHits, skillScore, roleScore };
}

// ---------- HR 活跃分 ----------
// freshness 信号优先用 publish_time;BOSS 直聘当前不暴露发布时间时,退化用面板 boss_activity。
function freshnessFromActivity(text) {
  const t = (text || '').toLowerCase();
  if (/刚刚/.test(t)) return 100;
  if (/今日|今天/.test(t)) return 90;
  if (/1\s*日内|1\s*天内/.test(t)) return 85;
  if (/3\s*日内|3\s*天内/.test(t)) return 70;
  if (/7\s*天内|一周/.test(t)) return 50;
  if (/月内/.test(t)) return 30;
  return null;
}

export function computeActiveScore(job, hr, opts = {}) {
  const now = opts.now ?? Date.now();
  const detail = { freshness: {}, urgent: {}, reply: {} };
  const jdFetched = job.jd_fetched ?? (job.jd ? 1 : 0);
  const S = (v) => String(v ?? ''); // 防御异常类型

  // 1) 新鲜度 40%(publish_time 优先,缺失则用 boss_activity)
  let freshnessScore = null;
  const pub = parsePublishAge(S(job.publish_time), now);
  if (pub.known) {
    const d = pub.days;
    freshnessScore = d <= 1 ? 100 : d <= 3 ? 80 : d <= 7 ? 40 : 20;
  } else if (job.boss_activity) {
    freshnessScore = freshnessFromActivity(S(job.boss_activity));
  }
  detail.freshness = {
    raw: S(job.publish_time) || S(job.boss_activity) || null,
    known: freshnessScore != null,
    days: pub.known ? pub.days : null,
    score: freshnessScore,
  };

  // 2) 急聘 20%(详情未抓取视为未知,忽略)
  let urgentScore = jdFetched ? (job.is_urgent ? 100 : 0) : null;
  detail.urgent = { raw: job.is_urgent, score: urgentScore };

  // 3) 历史回复速度 40%(hr 对象无数据视为未知)
  let replyScore = null;
  if (hr && hr.avg_reply_sec != null) {
    const s = hr.avg_reply_sec;
    replyScore = s <= 600 ? 100 : s <= 1800 ? 80 : s <= 14400 ? 60 : 30;
  }
  detail.reply = { raw: hr?.avg_reply_sec ?? null, score: replyScore };

  // 归一:仅按已知信号加权;全部未知给中性 50
  const known = [];
  if (freshnessScore != null) known.push([freshnessScore, 0.4]);
  if (urgentScore != null) known.push([urgentScore, 0.2]);
  if (replyScore != null) known.push([replyScore, 0.4]);
  if (!known.length) return { score: 50, detail };
  const wSum = known.reduce((a, [, w]) => a + w, 0);
  const score = Math.round(known.reduce((a, [s, w]) => a + s * w, 0) / wSum);
  return { score, detail };
}

// ---------- 统一分 ----------
export function computeTotal(match, active, cfg) {
  return Math.round(match * cfg.weight_match + active * cfg.weight_active);
}

// ---------- LLM 简历对比评分(详细对比 JD ↔ 完整简历) ----------
export async function llmScore(job, profile, cfg) {
  const llm = cfg.llm || {};
  if (!llm.enabled || !llm.api_key) return null;
  const sys = `你是专业的招聘匹配专家。对比「岗位JD」与「求职者完整简历」,给出真实、客观、可解释的匹配度评分。

评分原则:
- 逐维度评估(技能/经验/学历/技术栈/职责),综合给出 0-100 总分
- 参考求职者的独特优势(如 AI Agent、网络安全、护网、CTF、爬虫自动化)是否与岗位契合,契合则加分
- 学历是硬性卡点(岗位明确要求本科而简历是大专)要如实反映,但若技能高度匹配可放宽
- 只输出 JSON:
{
  "score": 85,
  "summary": "一句话结论",
  "dimensions": {
    "技能匹配": { "score": 90, "matched": ["python","vue"], "missing": ["k8s"], "note": "..." },
    "经验年限": { "score": 80, "note": "..." },
    "学历要求": { "score": 70, "note": "..." },
    "技术栈契合": { "score": 85, "note": "..." },
    "职责匹配": { "score": 88, "note": "..." }
  },
  "strengths": ["AI Agent 项目经验", "网络安全背景"],
  "gaps": ["学历为大专,部分岗位要求本科"]
}`;
  const resumeText = profile.resume_text || `姓名:${profile.name}\n年限:${profile.years_experience}年\n学历:${profile.education}\n技能:${JSON.stringify(profile.skills)}`;
  const user = `# 岗位 JD\n${job.title}\n${job.salary || ''}\n${cleanJd(job.jd || job.title).slice(0, 3000)}\n\n# 求职者完整简历\n${resumeText.slice(0, 4000)}`;
  try {
    const res = await fetch(`${llm.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
      signal: AbortSignal.timeout(30000), // LLM 超时 30s,防止挂起锁死调度
      body: JSON.stringify({
        model: llm.model || 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const dims = parsed.dimensions || {};
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      summary: parsed.summary || '',
      dimensions: dims,
      strengths: parsed.strengths || [],
      gaps: parsed.gaps || [],
    };
  } catch (e) {
    console.warn(`  [LLM] ${job.job_id} 调用失败: ${e.message}`);
    return null;
  }
}

// ---------- 上层封装 ----------
// 单个岗位评分(不写库),返回 { match, active, total, mDetail, aDetail }
export function scoreJob(job, cfg, profile) {
  const { score: match, detail: mDetail } = computeMatchScore(job, profile, { hardExclude: cfg.hard_exclude });
  const hr = job.company ? getHrStat(job.company) || null : null;
  const { score: active, detail: aDetail } = computeActiveScore(job, hr, {});
  const total = computeTotal(match, active, cfg);
  return { match, active, total, mDetail, aDetail };
}

// 对库中岗位评分入库,返回结果数组(供 dispatcher 复用)
export async function runScoring(opt = {}) {
  const cfg = loadConfig();
  if (opt.llm) { cfg.llm = { ...cfg.llm, enabled: true }; }
  const profile = loadResumeProfile();
  openDb(cfg.db_path);

  const llmOn = !!(cfg.llm?.enabled && cfg.llm?.api_key);
  if (!opt.quiet) console.log(`评分模型: ${llmOn ? 'rule+llm' : 'rule'} | 权重: 匹配${cfg.weight_match} / 活跃${cfg.weight_active} | 排除词: ${cfg.hard_exclude ? '硬性' : '软性'}`);

  const jobs = opt.jobId ? [getJob(opt.jobId)].filter(Boolean) : listJobs();
  if (!jobs.length) { if (!opt.quiet) console.log('岗位库为空,先运行 node collector.mjs 采集'); closeDb(); return []; }

  const wSim = cfg.score_blend?.similarity ?? 0.4;
  const wLlm = cfg.score_blend?.llm ?? 0.6;
  const llmDeadline = Date.now() + 120000; // 整轮 LLM 最多 2 分钟,防止串行超时锁死单槽位
  let llmTimedOut = 0;
  const llmFailedIds = [];
  let hybridCount = 0, llmCacheHits = 0;
  const results = [];
  for (const job of jobs) {
    const r = scoreJob(job, cfg, profile); // 规则参考(含活跃分)
    const sim = computeSimilarity(job, profile);
    let match = sim.score; // 无 LLM 时纯相似度分
    let llm = null;
    // AI 辅助:有完整 JD 的岗位做 LLM 详细对比(结果缓存,新岗位才调用)
    const llmEligible = !!(job.jd && job.jd.length > 50);
    if (llmOn && llmEligible && Date.now() < llmDeadline) {
      const cached = getCachedLlm(job.job_id);
      if (cached) { llm = cached; llmCacheHits++; }
      else llm = await llmScore(job, profile, cfg);
      if (llm) { match = Math.round(sim.score * wSim + llm.score * wLlm); hybridCount++; } // 统一融合
      else if (job.jd) { llmTimedOut++; llmFailedIds.push(job.job_id); }
    }
    const active = r.active;
    const total = computeTotal(match, active, cfg);
    const method = llm ? 'hybrid' : 'similarity';
    upsertCandidate({
      job_id: job.job_id, match_score: match, active_score: active, total_score: total,
      score_method: method, score_detail: JSON.stringify({ similarity: sim, llm, blend: { similarity: wSim, llm: wLlm } }),
    });
    results.push({ job, match, active, total, similarity: sim, llm, method });
  }
  if (llmTimedOut) console.warn(`  [评分] ${llmTimedOut} 个岗位 LLM 调用失败/超时,已降级为纯相似度分: ${llmFailedIds.slice(0, 10).join(',')}${llmFailedIds.length > 10 ? '…' : ''}`);
  if (!opt.quiet) console.log(`  [评分] 本轮 ${results.length} 个:hybrid ${hybridCount}(LLM 缓存命中 ${llmCacheHits}),纯相似度 ${results.length - hybridCount}`);

  if (!opt.quiet) {
    const threshold = opt.threshold ?? 0;
    const usable = results
      .filter((r) => (r.llm ? r.llm.score : r.total) >= threshold)
      .sort((a, b) => (b.llm ? b.llm.score : b.total) - (a.llm ? a.llm.score : a.total))
      .slice(0, opt.top);

    console.log(`\n=== 候选清单(${usable.length}/${results.length} 条 ≥ ${threshold} 分) ===`);
    usable.forEach((r, i) => {
      const score = r.llm ? r.llm.score : r.total;
      const act = (r.job.boss_activity || '-').padEnd(8);
      const tag = (JSON.parse(r.job.tags || '[]').slice(0, 3).join('/') || '-');
      console.log(`#${i + 1} [${score}分] ${r.job.title} | ${r.job.salary || '-'} | ${r.job.company} | ${r.job.location || '-'}`);
      console.log(`   相似度${r.similarity?.score ?? '-'}${r.llm ? ` LLM ${r.llm.score}` : ''} 融合${r.match} | 活跃${r.active} | HR:${act} | ${tag}`);
      console.log(`   理由: ${briefReason(r)}`);
    });
  }

  closeDb();
  return results;
}

// ---------- CLI ----------
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    jobId: get('--job'),
    threshold: get('--threshold') !== undefined ? Number(get('--threshold')) : 0,
    top: get('--top') !== undefined ? Number(get('--top')) : Infinity,
    llm: args.includes('--llm'),
  };
}

function getCachedLlm(jobId) {
  try {
    const row = getDb().prepare('SELECT score_detail FROM candidates WHERE job_id=?').get(jobId);
    if (row?.score_detail) {
      const d = JSON.parse(row.score_detail);
      if (d?.llm) return d.llm;
    }
  } catch {}
  return null;
}

// 一句话可解释理由(供 dispatcher list / 面板复用)
// 新统一格式:r.similarity(相似度) + r.llm(AI辅助) → 融合分
export function briefReason(r) {
  if (r.similarity) {
    const parts = [`相似度${r.similarity.score}`];
    if (r.llm) {
      if (r.llm.summary) parts.push(`结论:${r.llm.summary}`);
      const dims = r.llm.dimensions || {};
      const best = Object.entries(dims).sort((a, b) => (b[1]?.score || 0) - (a[1]?.score || 0))[0];
      if (best) parts.push(`${best[0]}${best[1].score}`);
      if (r.llm.strengths?.length) parts.push(`优势:${r.llm.strengths.slice(0, 2).join('/')}`);
      if (r.llm.gaps?.length) parts.push(`差距:${r.llm.gaps.slice(0, 2).join('/')}`);
    }
    return parts.slice(0, 4).join('; ');
  }
  // 旧格式(仅有 LLM,无 similarity)
  if (r.llm) {
    const dims = r.llm.dimensions || {};
    const parts = [];
    if (r.llm.summary) parts.push(`结论:${r.llm.summary}`);
    const best = Object.entries(dims).sort((a, b) => (b[1]?.score || 0) - (a[1]?.score || 0))[0];
    if (best) parts.push(`${best[0]}${best[1].score}`);
    if (r.llm.strengths?.length) parts.push(`优势:${r.llm.strengths.slice(0, 2).join('/')}`);
    if (r.llm.gaps?.length) parts.push(`差距:${r.llm.gaps.slice(0, 2).join('/')}`);
    return parts.slice(0, 4).join('; ') || `LLM ${r.llm.score}分`;
  }
  const md = r.mDetail || {};
  const parts = [];
  const title = md.title || {};
  if (title.role_hits?.length) parts.push(`标题命中「${title.role_hits.join('/')}」`);
  if (title.skill_hits?.length) parts.push(`标题技能「${title.skill_hits.join('/')}」`);
  const tags = md.tags || {};
  if (tags.edu?.req?.label && tags.edu.req.label !== '学历不限') parts.push(`学历要求${tags.edu.req.label}`);
  if (tags.years?.req) parts.push(`${tags.years.req.min}-${tags.years.req.max}年`);
  const jd = md.jd || {};
  if (jd.hits?.length) parts.push(`JD命中${jd.hits.length}技能`);
  if (md.excluded?.length) parts.push(`⚠排除词「${md.excluded.join('/')}」`);
  const ad = r.aDetail || {};
  if (ad.freshness?.raw) parts.push(`HR${ad.freshness.raw}`);
  if (r.job && r.job.is_urgent) parts.push('急聘');
  return parts.slice(0, 4).join('; ') || '无明显命中特征';
}

async function main() {
  const opt = parseArgs();
  await runScoring(opt);
}

// 仅作为 CLI 直接运行时执行(被 dispatcher import 时不触发)
if (import.meta.main) {
  main().catch((e) => {
    console.error('\n评分失败:', e.message);
    process.exit(1);
  });
}
