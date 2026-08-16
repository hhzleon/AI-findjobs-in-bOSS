# 自动简历投递 — BOSS 直聘 CDP 自动化

通过 Chrome DevTools Protocol(CDP)控制本机 Edge/Chrome,完成**获取岗位 → 评分 → 候选清单 → 打招呼 → 发消息 → 发简历 → 反馈**的完整投递链路。
零第三方依赖(Node 22+ 原生 WebSocket + fetch + node:sqlite)。

## 环境准备

1. 启动带 CDP 调试端口的浏览器(默认端口 `9222`,可用环境变量 `CDP_PORT` 修改),**使用项目持久化 profile(登录态保留)**:

   ```bash
   # 方式一(推荐):项目内脚本,一键启动
   start-browser.bat     # Windows 双击或 cmd
   ./start-browser.sh    # Git Bash

   # 方式二:手动启动
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
     --remote-debugging-port=9222 \
     --user-data-dir="D:\项目\自动简历投递\自动简历投递\.edge-profile" \
     https://www.zhipin.com/web/geek/jobs
   ```

   > 必须用独立的 `--user-data-dir`(不要用日常浏览器配置,否则调试端口不生效)。
   > `.edge-profile` 是项目持久化目录:第一次使用需在浏览器里扫码登录 BOSS 直聘一次,
   > 之后每次启动都保持登录态,免重复登录。

2. 在浏览器里登录 BOSS 直聘(扫码),进入岗位搜索列表页 `https://www.zhipin.com/web/geek/jobs`。

## 可视化面板(推荐:网页操作)

启动浏览器后,再启动管理面板:

```bash
start-server.bat        # Windows:启动面板并自动打开 http://localhost:8111
# 或手动: node server.mjs(端口用 PORT 环境变量改)
```

面板功能:
- **总览**:岗位库 / 候选 / 已投递 / 今日上限 / HR 活跃等统计卡片,CDP 浏览器在线状态
- **候选清单**:按分数排序,含匹配/活跃分、HR 活跃度、可解释理由;勾选后一键投递(有确认弹窗)
- **聊天**:会话列表(可搜索)→ 点开读消息 → 输入发送 / 一键发简历请求;批量任务运行时自动锁定
- **投递记录 / HR 活跃**:查看投递状态与 HR 回复速度
- **操作与日志**:一键「采集 / 重新评分 / 扫描回复反馈」,子进程实时输出日志
- 长任务(采集/投递/反馈)后台运行,页面轮询日志,互斥保护(同一时间只跑一个,聊天同步锁定)

> 数据实时从 `data/apply.db` 读取;操作通过子进程调用 dispatcher,复用 CLI 全部能力。

## 部署与无人监管运行

### 启动(开机跑起来后即可不管)

```bash
start-browser.bat      # 1. 启动浏览器(CDP 9222,登录态持久化)
start-server.bat       # 2. 启动面板(端口占用自动顺延,自动拉起调度/AI助手)
```

### 无人监管自动闭环(可同时开)

| 开关 | 位置 | 行为 |
|------|------|------|
| 定时采集 | 面板「操作与日志」| 每 60 分钟抓新岗位 + 重评分 |
| 自动投递 ≥70 | 同上 | 采集评分完成后,自动向 ≥70 分未投岗位打招呼 |
| AI 助手 | 面板「AI 助手」| 自动跟 HR 对话/发简历/标记不合适 |

- **开关状态持久化**:采集/自动投递/AI 助手开启后写入 meta,服务器重启自动恢复(不会丢状态)
- **失败自愈**:端口占用自动顺延、agent 崩溃自动重启(连续5次熔断)、采集 tab 失效自动换新、LLM 超时降级纯规则分、投递单岗位异常不中断整批
- **风控**:随机间隔、每日上限、检测到验证码自动暂停;采集/详情连续失败自动中止避免空转
- **可观测**:面板显示「上次采集时间」;日志持久化到 `data/logs/`(重启不丢)

### 交付要求

- 环境:Node 22+(推荐 24),Windows(本机路径含中文,脚本已适配)
- 首次需在浏览器完成 BOSS 扫码登录 + 填写在线简历(否则详情页投递会弹「完善简历」)
- 建议工作时段开机运行,偶尔扫一眼日志(验证码需人工)

### 定时自动采集(自动抓新一批职位)

面板「操作与日志」页点「定时自动采集」开关,或改 `config.json`:

```json
"scheduler": { "enabled": true, "collect_interval_min": 60 }
```

开启后服务器每隔 N 分钟(默认 60)自动运行:采集新岗位 → 重评分 → 入候选清单,全程无需人工。
- 浏览器离线或已有任务运行时自动跳过本轮,不冲突
- 自动采集用的是岗位页,不影响聊天页(聊天只在 AI 助手或 apply/feedback 任务运行时锁定)

### 统一评分规则(相似度算法 + AI 辅助)

`match_score` 是**相似度 + LLM 的统一融合分**,不是二选一:

```
相似度算法(0-100) = JD ↔ 简历重叠度(技能命中加权 + 标题角色),纯量化不调 LLM
AI 辅助(0-100)   = LLM 详细对比 JD 与完整简历(语义判断)
match_score      = 相似度 × 0.4 + LLM × 0.6   (config.json 的 score_blend 可调)
total            = match_score × 0.7 + 活跃 × 0.3
```

- 有完整 JD 的岗位都走 LLM 对比,结果缓存;无 LLM 时退化为纯相似度分
- 面板候选行「简历对比」弹窗可看各维度分、命中/缺失技能、优势/差距
- 简历源头:面板「简历」页粘贴保存(`resume_profile.json.resume_text`)

### 自动投递(≥分候选直接打招呼)

面板「操作与日志」页点「自动投递≥70」开关,或改 `config.json`:

```json
"auto_apply": { "enabled": true, "min_score": 70 }
```

开启后,每次定时采集+评分完成,**自动向所有 ≥min_score 的未投递岗位打招呼**(发真实消息)。
- 受**每日上限 `daily_limit`(默认 20)**约束,超限自动停止
- 每条投递间随机间隔(`min/max_interval_sec`),节奏像人
- 已投递的岗位不会重复投
- 也可手动触发:`node dispatcher.mjs apply --min 70`(面板「立即投递≥70」按钮)

## AI 对话代理(自动打招呼 / 聊天 / 发简历 / 筛选不合适)

面板「AI 助手」页一键启动 `node agent.mjs loop`,自动监听聊天会话:

- **监听新回复**:按 `data-mid` 追踪,只对 HR 的新消息反应(首次启动只登记不轰炸历史会话)
- **AI 对话**:LLM 根据简历画像 + 岗位 JD + 对话记录,生成得体回复并自动发送
- **自动发简历**:HR 要简历 → 自动发出附件简历请求
- **自动筛选**:HR 明确说「不合适/已招满/不匹配」→ 自动标记 `rejected` 并停止投入(理由入库,面板可见)
- **安全护栏**:不暴露是 AI、只基于画像事实回答、动作间随机延迟(8-25s)、夜间静默(0-8 时)、验证码即停

### 配置 LLM(建议)

编辑 `config.json`:

```json
"llm": { "enabled": true, "api_key": "sk-你的DeepSeekKey", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat" }
```

未配置 key 时自动降级为**关键词规则**(仅识别常见场景:要简历/问薪资/说不合适),可用但不智能。
`agent` 段可调:监听间隔、动作延迟、静默时段、`persona`(人设语气)。

```bash
node agent.mjs once        # 手动跑一轮
node agent.mjs loop        # 持续监听(面板里点「启动 AI 助手」等价)
node agent.mjs once --mock # 强制关键词模式(测试用)
```

> 全自动聊天有平台风控风险,已内置限频与静默;但请在了解风险后使用。

## 使用(推荐:dispatcher 全流程)

```bash
# 1. 采集新岗位(按 config.json 的 search_keywords,列表翻页 + 面板抓 JD/标签/HR活跃度)
node dispatcher.mjs collect

# 2. 评分(规则评分 + 可解释理由,结果入 candidates 表)
node dispatcher.mjs score

# 3. 候选清单(≥60 分,未投递,按总分降序)
node dispatcher.mjs list

# 4. 投递指定候选(序号取 list 输出;打招呼+发自定义消息)
node dispatcher.mjs apply --ids 0,2,5

#    投递前 3 名 / 顺带发简历 / 演练
node dispatcher.mjs apply --top 3
node dispatcher.mjs apply --ids 1 --resume
node dispatcher.mjs apply --top 1 --dry-run

# 5. 投递/回复状态
node dispatcher.mjs status

# 6. 反馈:扫描聊天会话,统计 HR 回复延迟(回写 hr_stats,评分自动受益)
node dispatcher.mjs feedback
```

> 风控自动处理:每日上限 `daily_limit`(默认 20)、随机间隔 `min/max_interval_sec`、
> 检测到验证码即暂停。发简历需双方互动后按钮才可用(见下文限制)。

### 单岗位投递(调试用)

```bash
node pipeline.mjs --list                     # 列出当前岗位列表
node pipeline.mjs --index 0                  # 投递第 1 个岗位:打招呼+发消息
node pipeline.mjs --index 0 --resume         # 投递并尝试发简历
node pipeline.mjs --index 2 --message "自定义消息"
node pipeline.mjs --index 0 --dry-run        # 演练模式
```

### 各模块单独运行

```bash
node collector.mjs                # 采集(全部搜索词,含详情)
node collector.mjs --keyword Python --pages 1   # 单词单页调试
node scorer.mjs --threshold 60    # 评分并输出清单(≥60)
node scorer.mjs --llm             # 启用 LLM 语义评分(需 config.json 配好 key)
node hrstats.mjs --limit 50       # 扫描会话更新 HR 统计
```

## 流程说明

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1. 采集 | 搜索词列表页翻页 + 点卡片读右侧面板 | 岗位/薪资/公司/标签/jobId + **JD 全文 + HR 活跃度(如「3日内活跃」)** |
| 2. 评分 | 规则评分 | 匹配分(标题40%/标签30%/JD30%,命中排除词归零)+ 活跃分(HR活跃40%/急聘20%/回复速度40%),统一加权 |
| 3. 候选清单 | 未投递岗位按总分降序,附可解释理由 | 命中技能/学历要求/HR活跃度等 |
| 4. 投递 | 打开岗位 → 立即沟通 → 发消息 | 自动写 `applied` 表(打招呼/发消息/发简历时间戳) |
| 5. 反馈 | 扫描聊天会话 | 对方首次回复延迟 → 回写 `hr_stats`,下次评分自动受益 |

### 关于发简历的限制(重要)

BOSS 直聘的防骚扰机制:**「发简历」按钮在双方建立互动前不可用**(显示为「求简历:双方回复后可用」)。
- 新打招呼的会话,第一次投递时只能完成打招呼 + 发消息;
- **等对方回复后**,再次投递该岗位(`dispatcher.mjs apply --ids N --resume`)即可发出附件简历请求;
- 请求发出后按钮锁定为「正在请求中,等待对方回复」,对方处理完(同意/拒绝)后才可再次请求。

## 数据模型(SQLite,`data/apply.db`)

| 表 | 内容 |
|---|---|
| `jobs` | 岗位库(jobId 主键,含 JD/急聘/HR活跃度/搜索词) |
| `candidates` | 评分结果(match/active/total + 可解释 score_detail) |
| `applied` | 投递记录(打招呼/发消息/发简历/回复时间,状态机) |
| `hr_stats` | HR 活跃度(回复计数/平均延迟/最近回复,按 `last_reply_at` 去重) |
| `meta` | 键值存储 |

`resume_profile.json` 为简历画像(技能/期望岗位/排除词),规则评分的依据,可手工微调。

## 模块结构

| 文件 | 职责 |
|------|------|
| `cdp.mjs` | 零依赖 CDP 客户端:连接、evaluate、真实键盘/鼠标输入、waitFor、事件订阅、验证码检测 |
| `jobs.mjs` | 岗位列表页:获取岗位列表、打开岗位卡片、打招呼进入聊天 |
| `chat.mjs` | 聊天页:选择会话、输入并发送消息、发简历请求 |
| `collector.mjs` | 采集层(**封包直采**):CDP 拦截浏览器自身的 `joblist.json` 响应 → 直接拿岗位 JSON(字段+encryptJobId),不再模拟点卡片/翻页;详情用 SEO 详情页导航读 JD |
| `scorer.mjs` | 评分层:规则评分(纯函数,可测试)+ 可选 LLM 增强 |
| `hrstats.mjs` | 反馈层:扫描会话计算 HR 回复延迟,回写 hr_stats |
| `pipeline.mjs` | 单岗位端到端投递(打招呼+发消息+发简历),写 applied 表 |
| `dispatcher.mjs` | 调度层:候选清单 → 确认 → 限频投递 → 状态/反馈 |
| `storage.mjs` | SQLite 数据层(零依赖 node:sqlite) |
| `config.mjs` | 配置与简历画像加载 |
| `server.mjs` | 零依赖 Web 管理面板(封装 dispatcher + 聊天 API + AI 助手进程管理) |
| `agent.mjs` | AI 对话代理:监听新回复 → LLM 回复/发简历/标记不合适(含关键词兜底) |
| `web/index.html` | 面板前端(单文件,无外部依赖;含聊天/AI 助手界面) |

## 测试

```bash
node --test tests/*.mjs
# 覆盖:数据层(storage)、评分纯函数(scorer)、配置加载(config)
```

## 常见问题

- **进程不退出/超时**:确保脚本结束处 `cdp.close()`;WebSocket 连接会阻塞 Node 退出。
- **找不到岗位页**:确认浏览器已打开 `web/geek/jobs` 且已登录。
- **「继续沟通」弹窗未出现**:网络慢时多等几秒,脚本已内置 8s 等待;若仍失败,手动点一次。
- **反馈扫描挂起**:聊天页会话点击偶发触发页面切换,脚本已对单会话加超时兜底;多个聊天 tab 会导致连接错乱,保留一个即可。
- **选择器失效**:BOSS 直聘前端改版会导致 class 变化,需按 `probe` 方式重新探测 DOM。
