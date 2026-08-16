// pipeline.mjs — BOSS 直聘自动投递端到端流程
// 用法:
//   node pipeline.mjs --list                    列出岗位
//   node pipeline.mjs --index 0 --resume        投递第 1 个岗位(打招呼+发消息+发简历)
//   node pipeline.mjs --index 2 --message "自定义消息"
//   node pipeline.mjs --index 0 --dry-run       只演练到聊天页,不实际发消息
// 也导出 applyJob() 供 dispatcher.mjs 复用(投递结果写入 applied 表)。
import { ensureJobsPage, fetchJobList, openJobCard, greetAndEnterChat } from './jobs.mjs';
import { sendMessage, canSendResume, sendResumeRequest, currentChatInfo } from './chat.mjs';
import { sleep, detectCaptcha } from './cdp.mjs';
import { openDb, closeDb, insertApplied, updateApplied, deleteApplied, isApplied } from './storage.mjs';
import { loadConfig } from './config.mjs';

// 默认打招呼消息:读 config.json 的 greeting_message(单一数据源)
function defaultGreeting() {
  return loadConfig().greeting_message;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    list: args.includes('--list'),
    dryRun: args.includes('--dry-run'),
    resume: args.includes('--resume'),
    index: get('--index') !== undefined ? Number(get('--index')) : undefined,
    message: get('--message') || defaultGreeting(),
  };
}

// 投递第 index 个岗位。返回 { ok, jobId, title, company, status, detail, steps }
export async function applyJob({ index, message, resume = false, dryRun = false, jobsCdp = null }) {
  const cfg = loadConfig();
  if (message == null) message = cfg.greeting_message;
  let ownJobsCdp = false;
  if (!jobsCdp) {
    jobsCdp = await ensureJobsPage();
    ownJobsCdp = true;
  }
  const jobs = await fetchJobList(jobsCdp);

  const job = jobs[index];
  if (!job) throw new Error(`岗位索引越界: ${index}(共 ${jobs.length} 个)`);

  const steps = { greeted: false, message: false, resume: false, captcha: null };
  const now = () => new Date().toISOString();
  const result = {
    ok: false, jobId: job.jobId, title: job.title, company: job.company,
    salary: job.salary, location: job.location, tags: job.tags, steps, status: 'pending', detail: '',
  };

  // 防重复投递(库里已投过则跳过)
  if (job.jobId && isApplied(job.jobId)) {
    result.ok = false;
    result.detail = `该岗位已投递过(${job.jobId}),跳过`;
    if (ownJobsCdp) jobsCdp.close();
    return result;
  }

  console.log(`\n=== 投递 [${index}] ${job.title} | ${job.salary} | ${job.company} ===`);

  // 验证码检查
  const captcha = await detectCaptcha(jobsCdp);
  if (captcha) {
    result.detail = `检测到验证码(${captcha}),已暂停`;
    steps.captcha = captcha;
    if (ownJobsCdp) jobsCdp.close();
    return result;
  }

  // 幂等占位(仅真实投递):先写 pending,防"打招呼后/写库前被杀"重复打招呼;dry-run 不写库
  if (!dryRun && job.jobId) {
    insertApplied({ job_id: job.jobId, title: job.title, company: job.company, status: 'pending' });
  }

  // 1) 打开岗位卡片
  console.log('[1/4] 打开岗位卡片…');
  await openJobCard(jobsCdp, index);

  // 2) 打招呼并进入聊天
  console.log('[2/4] 打招呼并进入聊天…');
  const greet = await greetAndEnterChat(jobsCdp);
  console.log(`      ${greet.detail}`);
  if (!greet.entered) {
    result.detail = `进入聊天失败: ${greet.detail}`;
    result.status = greet.greeted ? 'greeted' : 'pending';
    if (greet.greeted && job.jobId) {
      updateApplied(job.jobId, { greeted_at: now(), status: 'greeted' });
      steps.greeted = true;
    } else if (job.jobId && !dryRun) {
      // 未真正打招呼(按钮未找到/页面未加载):释放占位,允许后续重试
      deleteApplied(job.jobId);
    }
    if (ownJobsCdp) jobsCdp.close();
    return result;
  }
  steps.greeted = true;
  if (!dryRun && job.jobId) updateApplied(job.jobId, { greeted_at: now(), status: 'greeted' });

  // 3) 发送消息:直接用刚跳转到聊天页的同一页面(jobsCdp),避免重新查找聊天 tab 连错会话
  const chatCdp = jobsCdp;
  await sleep(1500);
  const info = await currentChatInfo(chatCdp);
  console.log(`      当前会话: ${info.chat ? info.chat.slice(0, 60) : '(未知)'}`);

  let msgSent = false;
  if (!dryRun) {
    console.log(`[3/4] 发送消息: ${message.slice(0, 40)}…`);
    const sent = await sendMessage(chatCdp, message);
    console.log(`      已发送: ${sent}`);
    msgSent = true;
    steps.message = true;
  } else {
    console.log('[3/4] (dry-run) 跳过发消息');
    console.log('[4/4] (dry-run) 跳过发简历');
  }

  // 4) 发送简历(可选)
  let resumeSent = false;
  if (resume && !dryRun) {
    console.log('[4/4] 发送简历…');
    const can = await canSendResume(chatCdp);
    if (!can) {
      console.log('      「发简历」按钮当前不可用(BOSS 直聘要求双方互动后可用)。');
    } else {
      const r = await sendResumeRequest(chatCdp);
      console.log(`      发简历: ${r.sent ? '✓ ' + r.detail : '✗ ' + r.detail}`);
      resumeSent = r.sent;
      steps.resume = r.sent;
    }
  } else if (resume && dryRun) {
    console.log('[4/4] (dry-run) 跳过发简历');
  } else {
    console.log('[4/4] 跳过(加 --resume 发送简历)');
  }

  // 推进投递记录(占位记录已存在,这里更新状态;dry-run 不写库)
  const status = resumeSent ? 'resume_sent' : (msgSent ? 'msg_sent' : 'greeted');
  if (!dryRun && job.jobId) {
    updateApplied(job.jobId, {
      msg_sent_at: msgSent ? now() : null,
      resume_req_at: resumeSent ? now() : null,
      status,
    });
  }

  result.ok = true;
  result.status = status;
  result.detail = `打招呼+${msgSent ? '发消息' : '未发消息'}${resumeSent ? '+发简历' : ''} 完成`;
  // 复用 tab:把用过的页签导航回岗位列表页(下次投递复用,避免每次新开)
  try { await jobsCdp.send('Page.navigate', { url: 'https://www.zhipin.com/web/geek/jobs' }); } catch {}
  // chatCdp === jobsCdp(同一页面),关闭由下方 ownJobsCdp 分支统一处理
  if (ownJobsCdp) jobsCdp.close();
  return result;
}

async function main() {
  const opt = parseArgs();
  const cfg = loadConfig();
  openDb(cfg.db_path);
  const jobsCdp = await ensureJobsPage();
  const jobs = await fetchJobList(jobsCdp);

  if (opt.list || opt.index === undefined) {
    console.log(`共 ${jobs.length} 个岗位:`);
    jobs.forEach((j, i) => {
      console.log(`[${i}] ${j.title} | ${j.salary} | ${j.company} | ${j.location} | tags: ${j.tags.join('/')}`);
    });
    jobsCdp.close();
    closeDb();
    if (opt.list) return;
    console.log('\n提示: 用 --index N 指定要投递的岗位(配合 --resume 发简历)');
    return;
  }

  const result = await applyJob({ index: opt.index, message: opt.message, resume: opt.resume, dryRun: opt.dryRun, jobsCdp });
  if (result.ok) {
    console.log('\n=== 投递完成 ===');
  } else {
    console.log(`\n=== 投递未完成: ${result.detail} ===`);
    process.exitCode = 1;
  }
  closeDb();
}

// 仅作为 CLI 直接运行时执行(被 dispatcher import 时不触发)
if (import.meta.main) {
  main().catch((e) => {
    console.error('\n执行失败:', e.message);
    process.exit(1);
  });
}
