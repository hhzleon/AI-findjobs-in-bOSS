// apply.mjs — 单个岗位投递执行核心(dispatcher 与 pipeline 共用)
// 流程:定位搜索页 → 打开岗位卡片 → 打招呼进聊天 → 发自我介绍消息 → (可选)发简历请求
import { ensureJobsPage, findJobIndexByHref, openJobCard, greetAndEnterChat } from './jobs.mjs';
import { sendMessage, canSendResume, sendResumeRequest } from './chat.mjs';
import { CDP, sleep, findPage, closeTarget, detectCaptcha } from './cdp.mjs';

// 对库中一个岗位执行投递。
// 返回 { jobId, status, greeted, sent, resumeReq, captcha, detail }
// status: 'sent' | 'already' | 'missing' | 'dry'
export async function applyJob(job, { message, resume = false, dryRun = false, city } = {}) {
  const label = `${job.title} @ ${job.company}`;
  const jobsCdp = await ensureJobsPage(job.search_keyword, city);
  const idx = await findJobIndexByHref(jobsCdp, job.job_link || '');
  if (idx < 0) {
    jobsCdp.close();
    return { jobId: job.job_id, status: 'missing', detail: '当前搜索页未找到该岗位(可能已下架或不在当前页)' };
  }
  await openJobCard(jobsCdp, idx);
  const greet = await greetAndEnterChat(jobsCdp);
  if (!greet.entered && greet.button === '已沟通') {
    jobsCdp.close();
    return { jobId: job.job_id, status: 'already', greeted: true, detail: '已沟通过,无需重复打招呼' };
  }
  if (!greet.entered) {
    jobsCdp.close();
    return { jobId: job.job_id, status: 'error', detail: `进入聊天失败: ${greet.detail}` };
  }

  // 打招呼后,同一标签页已跳到聊天页
  const chatTarget = await findPage((t) => t.url.includes('web/geek/chat'));
  if (!chatTarget) {
    jobsCdp.close();
    return { jobId: job.job_id, status: 'error', detail: '未找到聊天页' };
  }
  const chatCdp = await CDP.connect(chatTarget.webSocketDebuggerUrl);
  await sleep(1500);

  let sent = null;
  let resumeReq = null;
  if (!dryRun) {
    try {
      sent = await sendMessage(chatCdp, message);
    } catch (e) {
      chatCdp.close();
      closeTarget(chatTarget.id);
      return { jobId: job.job_id, status: 'error', greeted: greet.greeted, detail: `发消息失败: ${e.message}` };
    }
    if (resume) {
      try {
        if (await canSendResume(chatCdp)) {
          const r = await sendResumeRequest(chatCdp);
          resumeReq = r.sent ? r.detail : null;
        } else {
          resumeReq = null;
        }
      } catch {
        resumeReq = null;
      }
    }
  }

  const captcha = await detectCaptcha(chatCdp).catch(() => null);
  chatCdp.close();
  closeTarget(chatTarget.id);

  return {
    jobId: job.job_id,
    status: dryRun ? 'dry' : 'sent',
    greeted: greet.greeted || !!sent,
    sent,
    resumeReq,
    captcha,
    detail: `${label} → 消息${sent ? '已发送' : '(dry)'}${resumeReq ? ' + 简历请求已发' : ''}`,
  };
}
