# 自动投递简历系统 — 设计文档

> 目标:提高求职效率 —— 不停抓取新岗位 → 按简历匹配度 + HR 活跃度统一评分 → 半自动投递。
> 已确认决策:规则为主+LLM可选增强 / 半自动投递 / 列表页+详情页抓取 / 多信号HR活跃度。

---

## 1. 现实约束(决定系统形态)

| 约束 | 影响 |
|---|---|
| BOSS 直聘防骚扰:打招呼有每日上限 | 系统必须限量投递(默认 20/天,可配) |
| 发简历需双方互动后才可用 | 打招呼/发消息自动;发简历在对方回复后二轮执行 |
| 高频操作触发验证码 | 所有操作加随机间隔,模拟人工节奏;检测到验证码立即暂停 |
| HR 活跃度无公开数据 | 用可观察信号推断:岗位新鲜度 + 急聘标签 + 历史会话回复速度 |
| 岗位详情页抓取有风控成本 | 仅对新岗位抓 JD,限速 2-3s/个 |

## 2. 系统架构

```
采集层 ──▶ 存储层 ──▶ 评分层 ──▶ 调度层 ──▶ 执行层 ──▶ 反馈层
collector  storage   scorer      dispatcher  pipeline   hrstats
 (抓新岗位)  (SQLite)   (统一分数)   (候选清单)  (真实投递)   (回复速度)
```

- 数据流:`jobs(岗位库) + hr_stats(HR活跃) + resume_profile(简历画像) → score → candidates(候选清单) → user 确认 → apply`
- 全程零第三方依赖:Node 24 内置 `node:sqlite`、`fetch`、`WebSocket`。

## 3. 数据模型(SQLite,`data/apply.db`)

### jobs — 岗位库(主键 jobId)
```sql
CREATE TABLE IF NOT EXISTS jobs (
  job_id        TEXT PRIMARY KEY,        -- 详情链接中的 jobId
  title         TEXT NOT NULL,
  salary        TEXT,
  tags          TEXT,                    -- JSON 数组:年限/学历/技能标签
  company       TEXT,
  location      TEXT,
  job_link      TEXT,
  jd            TEXT,                    -- 详情页 JD 描述
  publish_time  TEXT,                    -- 发布时间(详情页)
  is_urgent     INTEGER DEFAULT 0,       -- 急聘标签
  search_keyword TEXT,                   -- 通过哪个搜索词抓到的
  fetched_at    TEXT DEFAULT (datetime('now','localtime')),
  jd_fetched    INTEGER DEFAULT 0        -- JD 是否已抓取
);
CREATE INDEX IF NOT EXISTS idx_jobs_fetched ON jobs(fetched_at);
```

### candidates — 评分结果(一岗位一记录,重新评分覆盖)
```sql
CREATE TABLE IF NOT EXISTS candidates (
  job_id         TEXT PRIMARY KEY REFERENCES jobs(job_id),
  match_score    REAL,                   -- 岗位匹配分 0-100
  active_score   REAL,                   -- HR 活跃分 0-100
  total_score    REAL,                   -- 统一分(可配权重)
  score_method   TEXT DEFAULT 'rule',    -- rule | llm | hybrid
  score_detail   TEXT,                   -- JSON:各维度得分与命中项(可解释)
  scored_at      TEXT DEFAULT (datetime('now','localtime'))
);
```

### applied — 投递记录
```sql
CREATE TABLE IF NOT EXISTS applied (
  job_id       TEXT PRIMARY KEY REFERENCES jobs(job_id),
  title        TEXT, company TEXT,
  total_score  REAL,
  greeted_at   TEXT,                     -- 打招呼时间
  msg_sent_at  TEXT,                     -- 消息发送时间
  resume_req_at TEXT,                    -- 发简历请求时间
  reply_at     TEXT,                     -- 对方首次回复时间
  reply_delay_sec INTEGER,               -- 回复延迟秒数
  status       TEXT DEFAULT 'pending'    -- pending|greeted|replied|rejected|paused
);
```

### hr_stats — HR 活跃度(多信号聚合)
```sql
CREATE TABLE IF NOT EXISTS hr_stats (
  boss_key        TEXT PRIMARY KEY,      -- 会话/BOSS 标识(公司名+联系人)
  company         TEXT,
  contact         TEXT,
  first_seen_at   TEXT,
  last_active_at  TEXT,
  reply_count     INTEGER DEFAULT 0,
  avg_reply_sec   INTEGER,               -- 平均回复延迟(秒)
  min_reply_sec   INTEGER
);
```

## 4. 简历画像(`resume_profile.json`,手工维护,可自动补全)

```json
{
  "name": "侯皓展",
  "years_experience": 5,
  "education": "大专",
  "skills": {
    "python": 5, "node.js": 5, "vue": 4, "react": 3,
    "fde": 5, "全栈": 5, "后端": 4, "自动化": 3, "golang": 3,
    "mysql": 4, "redis": 3, "docker": 3, "linux": 3
  },
  "preferred_roles": ["全栈工程师", "Python 开发", "Node.js 开发", "自动化"],
  "exclude_keywords": ["销售", "运营", "客服", "两班倒", "包吃住"]
}
```

## 5. 评分模型(统一 0-100)

### 5.1 岗位匹配分 `match_score`(默认权重 0.7)
| 维度 | 权重 | 算法 |
|---|---|---|
| 标题关键词 | 40% | `preferred_roles` + `skills` 命中数/期望命中数,命中技能越多分越高 |
| 标签匹配 | 30% | 年限匹配(±1 年不扣,超出递减)+ 学历匹配(大专不卡本科?可配)+ 技能标签命中 |
| JD 描述 | 30% | JD 中技能词出现次数加权(技能权重×出现),归一化到 100 |
| 排除词 | — | 命中 `exclude_keywords` 直接记 0 分或大幅扣分(可配 `hard_exclude: true`) |

### 5.2 HR 活跃分 `active_score`(默认权重 0.3)
| 信号 | 权重 | 算法 |
|---|---|---|
| 岗位新鲜度 | 40% | 发布时间 ≤1 天:100;1-3 天:递减;3-7 天:40;>7 天:20 |
| 急聘标签 | 20% | `is_urgent=1` 得 100,否则 0 |
| 历史回复速度 | 40% | `hr_stats.avg_reply_sec`:≤10min:100;10-30min:80;1-4h:60;>4h:30;无数据:50(中性) |

### 5.3 统一分
```
total = match_score * W_MATCH + active_score * W_ACTIVE   (W_MATCH=0.7, W_ACTIVE=0.3, 可配)
```

### 5.4 LLM 增强(可选)
- 配置 `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`(兼容 OpenAI 格式,如 DeepSeek)
- 配置后对 JD+简历画像调用一次语义评分(0-100 + 理由),结果缓存到 `candidates.score_method='llm'`,同 jobId 不重复调用
- 未配置则纯规则评分,功能不受影响

## 6. 采集策略(`collector.mjs`)

1. 搜索词列表(可配,建议 3-5 个:`全栈工程师`、`Python 开发`、`Node.js`、`自动化测试` 等)
2. 对每个词抓列表页 1-3 页(每页 15 条),提取岗位卡片
3. 对库中 `jd_fetched=0` 的新岗位,逐个进详情页抓 JD + 发布时间 + 急聘标记,限速 2-3s/个
4. 去重:`jobId` 已存在则跳过(除非标题/薪资变化大)
5. 采集频率:每次运行建议间隔 ≥15 分钟,避开风控

## 7. HR 活跃度采集(`hrstats.mjs`)

1. 进入聊天页,遍历会话列表,提取:联系人/公司、最后消息时间、未读状态
2. 对 `applied` 中已打招呼的会话,扫描消息区:对方回复时间 - 打招呼时间 = 回复延迟,回写 `hr_stats`
3. 冷启动:无历史数据时,HR 活跃分只用新鲜度+急聘(权重自动归一)

## 8. 调度与投递(`dispatcher.mjs` — 半自动)

```
dispatcher list     # 生成候选清单:未投递岗位按 total 降序,输出分数+理由
dispatcher apply --ids 1,2,5   # 用户确认后投递
dispatcher status   # 查看投递/回复状态
dispatcher feedback # 扫描会话更新 hr_stats
```

**投递动作序列**(每个岗位):
1. 打开岗位 → 立即沟通(打招呼,自动)
2. 发自我介绍消息(可配模板,自动)
3. 若该岗位 HR 历史回复快(活跃分高)或会话可用,尝试发简历请求(自动,失败不阻塞)
4. 记录到 `applied`

**风控参数**(`config.json`):
- `daily_limit`: 20(打招呼/天)
- `min_interval_sec` / `max_interval_sec`: 60 / 120(随机间隔)
- `score_threshold`: 60(低于不投)
- `hard_exclude`: true
- `pause_on_captcha`: true(检测到滑块/验证码即暂停并提示)

## 9. 反馈闭环

- 每次投递后记录 `greeted_at`、`msg_sent_at`
- 定期 `feedback` 扫描会话,得到 `reply_at` → 更新 `hr_stats.avg_reply_sec`
- 评分下次自动受益:回复快的 HR 对应岗位活跃分提升

## 10. 实施计划(里程碑)

| 阶段 | 内容 | 交付 |
|---|---|---|
| M1 数据层 | storage.mjs(SQLite)+ config.json + resume_profile.json | 岗位/候选/投递/HR 统计可读写 |
| M2 采集层 | collector.mjs:列表页翻页 + 详情页 JD + 去重入库 | `node collector.mjs` 可抓取落库 |
| M3 评分层 | scorer.mjs:规则评分 + 详情可解释输出 | `node scorer.mjs` 输出分数清单 |
| M4 HR 活跃 | hrstats.mjs:会话扫描 + 回复延迟回写 | `node dispatcher.mjs feedback` |
| M5 调度投递 | dispatcher.mjs:清单 → 确认 → 限频投递 | `dispatcher apply` 完整跑通 |
| M6 LLM 增强(可选) | 配置 key 后自动升级语义评分 | 评分更准 |
| M7 打磨 | 验证码暂停、日志、异常恢复、README | 可日常使用 |

## 11. 待你确认的参数(先给默认值,随时可改)

- 搜索词:默认 `["全栈工程师","Python 开发","Node.js","自动化"]`
- 每日投递上限:默认 20
- 分数阈值:默认 60(低于不投)
- 发简历:默认在打招呼+发消息后尝试(对方已互动会话才成功)
- 运行频率:采集 每 15-30 分钟;投递 手动触发(半自动)

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 触发验证码/风控 | 限频 + 随机间隔 + 检测到即暂停;投递用真实浏览器(CDP)模拟人工 |
| LLM 调用成本 | 结果缓存;仅对规则分 ≥50 的岗位调 LLM;可配置模型与开关 |
| HR 活跃分冷启动不准 | 无数据时取中性值 50,权重自动归一;随使用积累变准 |
| 岗位列表变化 | 按 jobId 去重,重抓仅更新;已投递永不重投 |
