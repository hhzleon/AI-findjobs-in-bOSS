// 数据层测试:node --test tests/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, closeDb,
  upsertJob, jobExists, getPendingDetailJobs, listJobs, countJobs, getJob,
  upsertCandidate, listCandidates,
  insertApplied, updateApplied, isApplied, listApplied, countAppliedToday,
  upsertHrStat, getHrStat,
  setMeta, getMeta,
} from '../storage.mjs';

beforeEach(() => {
  openDb(':memory:');
});

test('jobs: 插入/去重/查询', () => {
  upsertJob({ job_id: 'j1', title: 'Python开发', salary: '20-30K', tags: ['Python', '3-5年'], company: '测试公司', location: '深圳', job_link: '/job_detail/j1.html', search_keyword: 'Python' });
  assert.equal(countJobs(), 1);
  assert.equal(jobExists('j1'), true);
  assert.equal(jobExists('j2'), false);

  // 重复插入不新增,JD 更新
  upsertJob({ job_id: 'j1', title: 'Python开发', salary: '20-30K', tags: ['Python'], company: '测试公司', location: '深圳', job_link: '/job_detail/j1.html', jd: '岗位描述全文', jd_fetched: 1 });
  assert.equal(countJobs(), 1);
  const j = getJob('j1');
  assert.equal(j.jd, '岗位描述全文');
  assert.equal(j.jd_fetched, 1);

  // 待抓详情
  upsertJob({ job_id: 'j2', title: '后端工程师', company: 'B公司', job_link: '/job_detail/j2.html' });
  const pend = getPendingDetailJobs();
  assert.equal(pend.length, 1);
  assert.equal(pend[0].job_id, 'j2');
});

test('candidates: 评分入库与清单过滤', () => {
  upsertJob({ job_id: 'j1', title: '岗位A', company: 'A公司', job_link: '/x.html' });
  upsertJob({ job_id: 'j2', title: '岗位B', company: 'B公司', job_link: '/x.html' });
  upsertCandidate({ job_id: 'j1', match_score: 90, active_score: 80, total_score: 87, score_method: 'rule', score_detail: '{"title_hits":["python"]}' });
  upsertCandidate({ job_id: 'j2', match_score: 40, active_score: 30, total_score: 37, score_method: 'rule', score_detail: '{}' });

  const top = listCandidates({ minScore: 60 });
  assert.equal(top.length, 1);
  assert.equal(top[0].job_id, 'j1');
  assert.equal(top[0].total_score, 87);

  // 投递后不再出现在清单
  insertApplied({ job_id: 'j1', title: '岗位A', company: 'A公司', total_score: 87 });
  const after = listCandidates({ minScore: 60 });
  assert.equal(after.length, 0);
});

test('applied: 投递记录与今日计数', () => {
  upsertJob({ job_id: 'j1', title: '岗位A', company: 'A公司', job_link: '/job_detail/j1.html' });
  insertApplied({ job_id: 'j1', title: '岗位A', company: 'A公司', total_score: 87, greeted_at: new Date().toISOString() });
  assert.equal(isApplied('j1'), true);
  assert.equal(countAppliedToday(), 1);

  updateApplied('j1', { reply_at: new Date().toISOString(), reply_delay_sec: 120, status: 'replied' });
  const a = listApplied()[0];
  assert.equal(a.status, 'replied');
  assert.equal(a.reply_delay_sec, 120);
});

test('hr_stats: 新增与累加平均延迟', () => {
  upsertHrStat({ boss_key: 'boss1', company: 'A公司', contact: '王女士', reply_count: 1, avg_reply_sec: 300, min_reply_sec: 300 });
  let s = getHrStat('boss1');
  assert.equal(s.avg_reply_sec, 300);
  assert.equal(s.reply_count, 1);

  // 第二次回复:新延迟 900,平均=(300+900)/2=600
  upsertHrStat({ boss_key: 'boss1', avg_reply_sec: 900, add_reply: true, min_reply_sec: 900 });
  s = getHrStat('boss1');
  assert.equal(s.reply_count, 2);
  assert.equal(s.avg_reply_sec, 600);
  assert.equal(s.min_reply_sec, 300);
});

test('hr_stats: 重复反馈按 last_reply_at 去重(回复不重复计数)', () => {
  // 第一次反馈:记录回复
  upsertHrStat({ boss_key: 'boss2', company: 'B公司', contact: '李先生', reply_count: 1, avg_reply_sec: 600, min_reply_sec: 600, add_reply: true, last_reply_at: '2026-08-16T08:00:00Z' });
  let s = getHrStat('boss2');
  assert.equal(s.reply_count, 1);
  assert.equal(s.avg_reply_sec, 600);

  // 再次反馈同一回复(相同时间)→ 不重复计数
  upsertHrStat({ boss_key: 'boss2', company: 'B公司', avg_reply_sec: 600, add_reply: true, min_reply_sec: 600, last_reply_at: '2026-08-16T08:00:00Z' });
  s = getHrStat('boss2');
  assert.equal(s.reply_count, 1, '同一回复不应重复计数');
  assert.equal(s.avg_reply_sec, 600);

  // 更新的回复 → 累加,平均=(600+1200)/2=900
  upsertHrStat({ boss_key: 'boss2', company: 'B公司', avg_reply_sec: 1200, add_reply: true, min_reply_sec: 1200, last_reply_at: '2026-08-16T10:00:00Z' });
  s = getHrStat('boss2');
  assert.equal(s.reply_count, 2);
  assert.equal(s.avg_reply_sec, 900);
  assert.equal(s.min_reply_sec, 600);
});

test('meta: 键值存储', () => {
  setMeta('last_collect_at', '2026-08-16 12:00:00');
  assert.equal(getMeta('last_collect_at'), '2026-08-16 12:00:00');
  assert.equal(getMeta('nope'), null);
});
