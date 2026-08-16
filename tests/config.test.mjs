// 配置加载测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadResumeProfile, validateConfig } from '../config.mjs';

test('config: 加载默认值 + 覆盖 + LLM 结构', () => {
  const c = loadConfig();
  assert.equal(typeof c.daily_limit, 'number');
  assert.ok(c.search_keywords.length >= 1);
  assert.equal(typeof c.weight_match, 'number');
  assert.equal(typeof c.greeting_message, 'string');
  assert.ok(c.greeting_message.length > 0);
  assert.equal(typeof c.llm.enabled, 'boolean');
  assert.equal(typeof c.llm.base_url, 'string');
});

test('config: 坏值(null/空串/布尔)回退默认而非边界', () => {
  const c = validateConfig({ daily_limit: null, score_threshold: '', weight_match: true });
  assert.equal(c.daily_limit, 50, 'null 应回退默认 50');
  assert.equal(c.score_threshold, 60, '空串应回退默认 60');
  assert.equal(c.weight_match + c.weight_active, 1, '权重应归一化');
});

test('config: 权重归一化(总分不超 100)', () => {
  const c = validateConfig({ weight_match: 1.0, weight_active: 1.0, score_blend: { similarity: 1, llm: 1 } });
  assert.equal(c.weight_match + c.weight_active, 1);
  assert.equal(c.score_blend.similarity + c.score_blend.llm, 1);
  assert.ok(c.weight_match <= 1 && c.weight_active <= 1);
});

test('config: quiet_hours 非法值回退默认', () => {
  const c1 = validateConfig({ agent: { quiet_hours: [23, 8] } }); // 跨午夜合法,保留
  assert.deepEqual(c1.agent.quiet_hours, [23, 8]);
  const c2 = validateConfig({ agent: { quiet_hours: [8] } }); // 长度1,回退
  assert.equal(c2.agent.quiet_hours.length, 2);
  const c3 = validateConfig({ agent: { quiet_hours: [25, 8] } }); // 越界,回退
  assert.equal(c3.agent.quiet_hours.length, 2);
});

test('config: search_keywords 过滤空串/非字符串,未知 key 提示', () => {
  const c = validateConfig({ search_keywords: ['Python', '', '  ', 123], typo_key: 1 });
  assert.deepEqual(c.search_keywords, ['Python'], '应过滤空串与非字符串');
  assert.equal(c.daily_limit, 50, '未知 key 不影响正常字段');
});

test('resume_profile: 画像字段齐全', () => {
  const p = loadResumeProfile();
  assert.equal(typeof p.years_experience, 'number');
  assert.equal(typeof p.education, 'string');
  assert.ok(Object.keys(p.skills).length >= 5);
  assert.ok(p.preferred_roles.length >= 1);
  assert.ok(p.exclude_keywords.length >= 1);
});
