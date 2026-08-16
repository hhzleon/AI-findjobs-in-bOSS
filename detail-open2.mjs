// detail-open2.mjs — 验证「立即沟通」路径:从列表页取新岗位 → 详情页 → clickChatButton(临时验证脚本)
import { CDP, openPage, sleep } from './cdp.mjs';
import { clickChatButton } from './jobs.mjs';
import { ensureJobsPage, fetchJobList } from './jobs.mjs';

const jobsCdp = await ensureJobsPage();
const jobs = await fetchJobList(jobsCdp);
if (!jobs.length) { console.log('列表无岗位'); process.exit(0); }

// 选第一个未投递的岗位(直接取第 0 个)
const job = jobs[0];
const detailUrl = 'https://www.zhipin.com' + job.href;
console.log(`目标岗位: ${job.title} | ${job.company} | ${detailUrl}`);

const page = await openPage(detailUrl);
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await sleep(3000);

const r = await clickChatButton(cdp, { timeoutMs: 25000 });
console.log('clickChatButton 结果:', JSON.stringify(r, null, 2));
cdp.close();
jobsCdp.close();
