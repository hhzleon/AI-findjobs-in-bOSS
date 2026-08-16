// llm.mjs — 可选 LLM 语义评分(OpenAI 兼容 API,如 DeepSeek)
// 仅在 config.llm.enabled 且配置 api_key 时生效;失败不阻塞主流程。
export async function llmScore(job, profile, cfg) {
  const { api_key, base_url, model } = cfg.llm || {};
  if (!cfg.llm?.enabled || !api_key) throw new Error('LLM 未启用或缺少 api_key');

  const skillDesc = Object.entries(profile.skills || {})
    .map(([k, v]) => `${k}(掌握度${v}/5)`).join('、');
  const excludeDesc = (profile.exclude_keywords || []).join('、');
  const prompt = `你是严谨的求职匹配助手。判断候选人是否适合该岗位,并给出 0-100 的匹配分。

候选人画像:
- ${profile.years_experience || '?'}年经验,学历 ${profile.education || '未知'}
- 技能:${skillDesc}
- 偏好岗位:${(profile.preferred_roles || []).join('、')}
- 明确不投(命中直接 0 分):${excludeDesc || '无'}

岗位信息:
- 职位:${job.title}
- 薪资:${job.salary || '未知'}
- 标签:${(job.tags || []).join('、')}
- JD:
${(job.jd || '无').slice(0, 3000)}

只输出 JSON:{"score": 0到100的整数, "reason": "不超过80字的中文理由"}`;

  const res = await fetch(`${base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你只输出合法 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(content);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (Number.isNaN(score)) throw new Error('LLM 返回 score 非法');
  return { score, reason: String(parsed.reason || '') };
}
