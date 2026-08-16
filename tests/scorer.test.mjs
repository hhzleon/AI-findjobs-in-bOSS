// 评分层纯函数测试:node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYears, parseEdu, parsePublishAge,
  computeMatchScore, computeActiveScore, computeTotal, computeSimilarity,
} from '../scorer.mjs';

const PROFILE = {
  name: '侯皓展',
  years_experience: 5,
  education: '大专',
  skills: { python: 5, 'node.js': 5, vue: 4, mysql: 4, docker: 3, 全栈: 5, 后端: 4, 自动化: 3 },
  preferred_roles: ['全栈工程师', 'Python开发', '后端开发'],
  exclude_keywords: ['销售', '客服', '两班倒'],
};

test('parseYears: 各种年限标签', () => {
  assert.deepEqual(parseYears(['3-5年', '大专']), { min: 3, max: 5 });
  assert.deepEqual(parseYears(['5年以上']), { min: 5, max: 99 });
  assert.deepEqual(parseYears(['5年']), { min: 5, max: 5 });
  assert.deepEqual(parseYears(['经验不限']), { min: 0, max: 1 });
  assert.equal(parseYears(['大专', '五险一金']), null);
});

test('parseEdu: 学历标签', () => {
  assert.deepEqual(parseEdu(['3-5年', '大专']), { level: 2, label: '大专' });
  assert.deepEqual(parseEdu(['本科']), { level: 3, label: '本科' });
  assert.equal(parseEdu(['3-5年']), null);
});

test('parsePublishAge: 发布时间解析', () => {
  const now = new Date('2026-08-16T12:00:00').getTime();
  assert.deepEqual(parsePublishAge('刚刚', now), { known: true, days: 0 });
  assert.equal(parsePublishAge('5天前', now).days, 5);
  assert.equal(parsePublishAge('3小时前', now).days, 0.125);
  assert.equal(parsePublishAge('2026-08-10', now).days, 6);
  assert.equal(parsePublishAge('长期', now).known, false);
  assert.equal(parsePublishAge('', now).known, false);
});

test('computeMatchScore: 命中排除词直接 0 分', () => {
  const r = computeMatchScore({ title: '销售专员', tags: [], jd: '' }, PROFILE, { hardExclude: true });
  assert.equal(r.score, 0);
  assert.ok(r.detail.excluded.includes('销售'));
});

test('computeMatchScore: 高度匹配岗位得分高', () => {
  const job = {
    title: 'Python后端开发工程师',
    tags: ['Python', '3-5年', '大专'],
    jd: '负责 Python 后端服务开发,使用 MySQL、Redis、Docker 部署,需要全栈能力与 node.js 经验',
  };
  const r = computeMatchScore(job, PROFILE, { hardExclude: true });
  assert.ok(r.score >= 80, `得分 ${r.score} 应 ≥80`);
  assert.ok(r.detail.title.role_hits.length >= 1, '标题应命中角色');
  assert.ok(r.detail.jd.hits.length >= 3, 'JD 应命中多个技能');
});

test('computeMatchScore: 年限不匹配适当扣分', () => {
  // 要求 8-10 年,候选 5 年 → 年限分下降
  const job = { title: 'Python后端开发', tags: ['8-10年', '大专'], jd: '' };
  const r = computeMatchScore(job, PROFILE);
  assert.ok(r.score < 90, `年限不匹配时得分 ${r.score} 应 <90`);
  assert.equal(r.detail.tags.years.req.max, 10);
});

test('computeMatchScore: 无 JD 时自动归一(不崩溃)', () => {
  const job = { title: 'Python开发', tags: ['3-5年', '大专'], jd: null };
  const r = computeMatchScore(job, PROFILE);
  assert.ok(r.score > 0);
  assert.equal(r.detail.jd.score, null);
});

test('computeActiveScore: 高活跃信号', () => {
  const now = new Date('2026-08-16T12:00:00').getTime();
  const job = { publish_time: '刚刚', is_urgent: 1, jd_fetched: 1 };
  const hr = { avg_reply_sec: 300 };
  const r = computeActiveScore(job, hr, { now });
  assert.equal(r.score, 100);
});

test('computeActiveScore: 全部信号未知给中性 50', () => {
  const r = computeActiveScore({ publish_time: null, jd_fetched: 0 }, null);
  assert.equal(r.score, 50);
});

test('computeActiveScore: 详情未抓取时急聘信号忽略并归一', () => {
  const now = new Date('2026-08-16T12:00:00').getTime();
  // 只有新鲜度(40/40)+ 无回复数据 → 归一后按新鲜度给分
  const r = computeActiveScore({ publish_time: '今天', is_urgent: 1, jd_fetched: 0 }, null, { now });
  assert.equal(r.score, 100);
});

test('computeTotal: 权重合成', () => {
  assert.equal(computeTotal(80, 60, { weight_match: 0.7, weight_active: 0.3 }), 74);
  assert.equal(computeTotal(0, 100, { weight_match: 0.7, weight_active: 0.3 }), 30);
});

test('computeSimilarity: 技能高度重叠得分高', () => {
  const job = { title: 'Python后端开发工程师', tags: ['Python'], jd: '负责 Python 后端,使用 MySQL、Redis、Docker,全栈开发' };
  const r = computeSimilarity(job, PROFILE);
  assert.ok(r.score >= 60, `相似度 ${r.score} 应 ≥60`);
  assert.ok(r.hits.includes('python'), '应命中 python');
  assert.ok(r.hits.includes('mysql') || r.hits.includes('redis'), '应命中数据库技能');
});

test('computeSimilarity: 无关岗位得分低', () => {
  const job = { title: '商场导购', tags: ['学历不限'], jd: '负责门店销售、顾客接待' };
  const r = computeSimilarity(job, PROFILE);
  assert.ok(r.score < 40, `无关岗位相似度 ${r.score} 应 <40`);
});

test('边界输入: 异常类型/空值不崩溃', () => {
  const bad = { title: 123, tags: 'not-array', jd: null };
  assert.doesNotThrow(() => computeMatchScore(bad, PROFILE, { hardExclude: true }));
  assert.doesNotThrow(() => computeSimilarity(bad, PROFILE));
  assert.doesNotThrow(() => computeActiveScore({ publish_time: null, boss_activity: null, is_urgent: 0, jd_fetched: 0 }, null, {}));
  const m = computeMatchScore(bad, PROFILE);
  assert.equal(typeof m.score, 'number');
});
