// collector.mjs — 采集层(封包直采版)
// 通过 CDP 注入 fetch/XHR 拦截器,捕获浏览器自身发出的 joblist.json 封包,
// 直接拿到岗位 JSON(全部字段 + encryptJobId),不再模拟点卡片/翻页找岗位。
// 详情用 SEO 详情页导航读 JD(免点击)。防风控:全程是浏览器自身合法请求。
// 用法:
//   node collector.mjs                # 全流程(列表封包 + 详情 JD)
//   node collector.mjs --no-detail    # 只抓列表
//   node collector.mjs --keyword Python   # 只跑指定搜索词
//   node collector.mjs --pages 1      # 每词只抓 1 页
import { CDP, sleep, findPage, detectCaptcha } from './cdp.mjs';
import { loadConfig } from './config.mjs';
import { openDb, closeDb, upsertJob, updateJobField, getPendingDetailJobs, countJobs, setMeta, getMeta } from './storage.mjs';

const BASE = 'https://www.zhipin.com/web/geek/jobs';
const isJobsPage = (t) => t.url.includes('web/geek/jobs') && !t.url.includes('chat');

// 注入到每个新文档的拦截器:捕获 joblist.json / job/detail.json 响应到 window.__CAPTURED__
const INJECT = `(() => {
  window.__CAPTURED__ = [];
  const push = (url, data) => window.__CAPTURED__.push({ url: String(url).slice(0, 120), data });
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    if (url.includes('joblist.json') || url.includes('job/detail.json')) {
      try { push(url, await resp.clone().json()); } catch (e) {}
    }
    return resp;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__probeUrl = url; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__probeUrl || '';
    if (url.includes('joblist.json') || url.includes('job/detail.json')) {
      this.addEventListener('load', () => { try { push(url, JSON.parse(this.responseText)); } catch (e) {} });
    }
    return origSend.apply(this, arguments);
  };
})()`;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    noDetail: args.includes('--no-detail'),
    keyword: get('--keyword'),
    pages: get('--pages') !== undefined ? Number(get('--pages')) : undefined,
  };
}

function searchUrl(keyword, city, page) {
  const q = keyword ? `query=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}` : `city=${encodeURIComponent(city)}`;
  return `${BASE}?${q}&page=${page}`;
}

// 轻量面板读取:点击第 index 张卡片,校验面板标题与目标岗位一致后读 HR 活跃度(.job-boss-info)
async function readBossActivity(cdp, index, expectTitle) {
  const ok = await cdp.evaluate(`(() => {
    const el = document.querySelectorAll('.job-card-box')[${index}];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  if (!ok) return null;
  // 等待面板加载出目标岗位(防串台读错卡片)
  for (let t = 0; t < 6; t++) {
    await sleep(600);
    if (!expectTitle) break;
    const panelTitle = await cdp.evaluate(`(() => {
      const el = document.querySelector('.job-detail-info .job-name, .job-detail-info .name');
      return el ? el.textContent.trim() : '';
    })()`);
    if (panelTitle && panelTitle.includes(expectTitle.slice(0, 5))) break;
  }
  const bossText = await cdp.evaluate(`(() => {
    const el = document.querySelector('.job-boss-info');
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  const m = bossText ? bossText.match(/(\d+\s*天内活跃|\d+\s*日内活跃|刚刚活跃|今日活跃|昨日活跃|今日回复\d+次)/) : null;
  return m ? m[1].replace(/\s+/g, '') : null;
}

// 导航搜索页并拦截 joblist.json 封包(最多重试3次,防御 __CAPTURED__ 未定义)
async function captureJobList(cdp, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cdp.evaluate('window.__CAPTURED__ = []');
      await cdp.send('Page.navigate', { url });
      await sleep(3500);
      let cap = await cdp.evaluate('window.__CAPTURED__').catch(() => []);
      cap = Array.isArray(cap) ? cap : [];
      const req = cap.find((c) => c.url.includes('joblist.json'));
      if (req?.data?.zpData?.jobList?.length) return req;
      // 同址导航 SPA 可能 no-op:强制刷新再试
      await cdp.send('Page.reload');
      await sleep(3500);
      cap = await cdp.evaluate('window.__CAPTURED__').catch(() => []);
      const req2 = (Array.isArray(cap) ? cap : []).find((c) => c.url.includes('joblist.json'));
      if (req2?.data?.zpData?.jobList?.length) return req2;
    } catch (e) {
      console.warn(`  [采集] 第${attempt + 1}次捕获失败: ${e.message}`);
    }
  }
  return null;
}

// 抓某一关键词的所有分页:导航到搜索页,拦截 joblist.json 封包直接入库
async function collectKeyword(cdp, cfg, keyword, maxPages) {
  let count = 0;
  for (let page = 1; page <= maxPages; page++) {
    const req = await captureJobList(cdp, searchUrl(keyword, cfg.city_code, page));
    const list = req?.data?.zpData?.jobList;
    if (!list || !list.length) {
      console.log(`\n[${keyword}] 第${page}页 未获取到岗位封包${req?.data?.code ? `(code=${req.data.code} ${req.data.message || ''})` : ''},停止本词。`);
      break;
    }
    console.log(`\n[${keyword}] 第${page}/${maxPages}页 封包获取 ${list.length} 个岗位`);
    let skipStatus = 0;
    for (const j of list) {
      if (j.jobValidStatus === 0) { skipStatus++; continue; } // 失效岗位不入库
      const jobId = j.encryptJobId;
      if (!jobId) continue;
      const location = [j.cityName, j.areaDistrict, j.businessDistrict].filter(Boolean).join('·');
      const tags = [...(j.jobLabels || []), ...(j.skills || [])];
      upsertJob({
        job_id: jobId, title: j.jobName, salary: j.salaryDesc,
        tags, company: j.brandName, location,
        job_link: `/job_detail/${jobId}.html`,
        search_keyword: keyword, search_page: page, security_id: j.securityId || null,
        is_urgent: /急聘/.test(j.jobName) ? 1 : 0,
        boss_activity: j.bossOnline ? '刚刚活跃' : null, // 封包在线信号:零点击,全岗位覆盖
        jd_fetched: 0,
      });
      count++;
    }
    if (skipStatus) console.log(`  [采集] 过滤失效岗位(jobValidStatus=0) ${skipStatus} 个`);
    // 轻量面板读取 HR 活跃度:仅对「封包未给出在线信号」的岗位点击富化(在线岗位已有「刚刚活跃」)
    let activityCount = 0, onlineSignal = 0;
    for (let i = 0; i < list.length; i++) {
      const job = list[i];
      if (!job.encryptJobId) continue;
      if (job.bossOnline) { onlineSignal++; continue; }
      const activity = await readBossActivity(cdp, i, job.jobName);
      if (activity) {
        updateJobField(job.encryptJobId, { boss_activity: activity });
        activityCount++;
      }
    }
    if (activityCount || onlineSignal) console.log(`  [采集] HR活跃度: 面板读取 ${activityCount} 个 + 封包在线信号 ${onlineSignal} 个`);

    // 验证码检查
    const captcha = await detectCaptcha(cdp);
    if (captcha) {
      console.error(`!! 检测到验证码(${captcha}),立即暂停。请手动处理后再试。`);
      process.exit(1);
    }
    if (page < maxPages) await sleep(1500 + Math.random() * 1500);
  }
  return count;
}

// 详情:对未抓 JD 的岗位,直接导航到 SEO 详情页读 .job-sec-text(免点击)
async function refreshPendingDetails(cfg) {
  const pend = getPendingDetailJobs(500);
  if (!pend.length) return 0;
  console.log(`\n详情抓取:${pend.length} 个岗位尚未抓 JD,逐页导航详情页…`);

  const tab = await openDetailTab();
  if (!tab) { console.error('无法打开详情页 tab,跳过'); return 0; }
  const cdp = tab.cdp;
  let done = 0;
  let failStreak = 0;
  for (const job of pend) {
    const url = `https://www.zhipin.com/job_detail/${job.job_id}.html`;
    await cdp.send('Page.navigate', { url });
    await sleep(2500);
    const d = await cdp.evaluate(`(() => {
      const sec = document.querySelector('.job-sec-text');
      const name = document.querySelector('.name');
      const salary = document.querySelector('.salary');
      return {
        jd: sec ? sec.textContent.replace(/\\s+/g, ' ').trim() : null,
        title: name ? (name.childNodes[0]?.textContent?.trim() || name.textContent.trim()) : null,
        salary: salary ? salary.textContent.trim() : null,
      };
    })()`);
    if (d && d.jd && d.jd.length > 20) {
      upsertJob({
        job_id: job.job_id, title: d.title || job.title, salary: d.salary || job.salary,
        tags: JSON.parse(job.tags || '[]'), company: job.company, location: job.location,
        job_link: job.job_link, search_keyword: job.search_keyword,
        jd: d.jd, is_urgent: /急聘/.test(d.title || '') ? 1 : 0,
        jd_fetched: 1,
      });
      done++;
      failStreak = 0;
    } else {
      failStreak++;
      if (failStreak >= 8) {
        // 连续失败(多为风控/页面异常):中止,避免空转浪费时间
        console.log(`  连续 ${failStreak} 个详情页读取失败,可能触发风控,中止详情抓取。`);
        break;
      }
    }
    await sleep((cfg.detail_fetch_interval_sec || 3) * 1000 + Math.random() * 500);
  }
  tab.cdp.close();
  tab.closeTab();
  return done;
}

// 打开一个临时详情 tab
async function openDetailTab() {
  const res = await fetch(`http://localhost:${process.env.CDP_PORT || '9222'}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) return null;
  const t = await res.json();
  const cdp = await CDP.connect(t.webSocketDebuggerUrl);
  return {
    cdp,
    closeTab: () => { try { cdp.close(); fetch(`http://localhost:${process.env.CDP_PORT || '9222'}/json/close/${t.id}`, { method: 'PUT' }).catch(() => {}); } catch {} },
  };
}

// 给 Promise 加超时(连接健康检查用)
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms))]);
}

// 连接岗位列表页;若旧 tab 失效(连接/健康检查挂起)则关闭并开新页
async function connectJobsPage(cfg) {
  const { openPage } = await import('./cdp.mjs');
  for (let attempt = 0; attempt < 2; attempt++) {
    let jobsPage = await findPage(isJobsPage);
    if (!jobsPage) {
      await openPage(searchUrl(cfg.search_keywords[0], cfg.city_code, 1));
      await sleep(4000);
      jobsPage = await findPage(isJobsPage);
      if (!jobsPage) throw new Error('无法打开岗位列表页');
    }
    const cdp = await CDP.connect(jobsPage.webSocketDebuggerUrl);
    // 健康检查:快速 evaluate,失败说明 tab 失效
    try {
      await withTimeout(cdp.evaluate('location.href'), 5000);
      return cdp;
    } catch (e) {
      console.warn(`[采集] 岗位页连接失效(${e.message}),换新页重试。`);
      try { await fetch(`http://localhost:${process.env.CDP_PORT || '9222'}/json/close/${jobsPage.id}`, { method: 'PUT' }); } catch {}
      cdp.close();
    }
  }
  throw new Error('无法连接岗位列表页');
}

// 采集主流程(可被 dispatcher 复用)
export async function runCollector(opt = {}) {
  const cfg = loadConfig();
  openDb(cfg.db_path);

  const keywords = opt.keyword ? [opt.keyword] : cfg.search_keywords;
  const maxPages = opt.pages || cfg.pages_per_keyword || 3;
  const noDetail = opt.noDetail;

  console.log(`采集开始(封包直采):${keywords.length} 个关键词,每词 ${maxPages} 页${noDetail ? '(仅列表)' : '(含详情)'}`);
  console.log(`城市码: ${cfg.city_code} | 详情间隔: ${cfg.detail_fetch_interval_sec}s`);

  // 连接岗位列表页(健康检查防失效 tab)并注入拦截器(跨导航存活)
  const cdp = await connectJobsPage(cfg);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

  let listCount = 0;
  try {
    for (const kw of keywords) {
      listCount += await collectKeyword(cdp, cfg, kw, maxPages);
    }
  } finally {
    cdp.close();
  }

  let detailDone = 0;
  if (!noDetail) {
    detailDone = await refreshPendingDetails(cfg);
  }

  console.log(`\n=== 采集完成 ===`);
  console.log(`本次列表封包入库: ${listCount} 条,详情抓取: ${detailDone} 条`);
  console.log(`岗位库总数: ${countJobs()}`);
  setMeta('last_collect_at', String(Date.now())); // 记录本次采集时间(可观测)
  closeDb();
  return { listCount, detailDone, total: countJobs() };
}

async function main() {
  const opt = parseArgs();
  await runCollector(opt);
}

// 仅作为 CLI 直接运行时执行(被 dispatcher import 时不触发)
if (import.meta.main) {
  main().catch((e) => {
    console.error('\n采集失败:', e.message);
    process.exit(1);
  });
}
