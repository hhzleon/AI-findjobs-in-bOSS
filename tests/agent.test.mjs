// AI 对话代理纯函数测试:决策分类 + 新消息追踪
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordDecide, newOtherMsgs, maxMid } from '../agent.mjs';

const M = (mid, dir, text) => ({ mid, dir, time: '14:00', text });

test('keywordDecide: HR 明确说不合适 → 标记 rejected', () => {
  const ctx = { transcript: [M('100', 'me', '您好'), M('101', 'other', '不好意思，这个岗位已经招满了')] };
  const d = keywordDecide(ctx);
  assert.equal(d.action, 'mark_rejected');
  assert.ok(d.reject_reason);
});

test('keywordDecide: 委婉拒绝也识别', () => {
  const d = keywordDecide({ transcript: [M('1', 'other', '感谢你的关注，但目前不考虑')] });
  assert.equal(d.action, 'mark_rejected');
});

test('keywordDecide: HR 要简历 → send_resume', () => {
  const d = keywordDecide({ transcript: [M('2', 'other', '方便发一份你的简历过来吗？')] });
  assert.equal(d.action, 'send_resume');
});

test('keywordDecide: 询问期望薪资 → reply', () => {
  const d = keywordDecide({ transcript: [M('3', 'other', '你的期望薪资是多少呢？')] });
  assert.equal(d.action, 'reply');
  assert.ok(d.reply.length > 5);
});

test('keywordDecide: 一般性寒暄/无明确意图 → no_action', () => {
  const d = keywordDecide({ transcript: [M('4', 'other', '好的')] });
  assert.equal(d.action, 'no_action');
});

test('keywordDecide: 邀约面试 → interview(含确认回复)', () => {
  const d = keywordDecide({ transcript: [M('5', 'other', '你明天方便来公司面试吗？')] });
  assert.equal(d.action, 'interview');
  assert.ok(d.reply.length > 5);
});

test('keywordDecide: 加微信聊面试 → interview', () => {
  const d = keywordDecide({ transcript: [M('6', 'other', '加个微信，聊下面试细节')] });
  assert.equal(d.action, 'interview');
});

test('keywordDecide: 对方道谢告别 → closed', () => {
  const d = keywordDecide({ transcript: [M('7', 'other', '好的，谢谢，再见')] });
  assert.equal(d.action, 'closed');
});

test('keywordDecide: 要简历优先于寒暄', () => {
  const d = keywordDecide({ transcript: [M('8', 'other', '可以，你发份简历来看看吧')] });
  assert.equal(d.action, 'send_resume');
});

test('newOtherMsgs: 只返回比 lastMid 新的 HR 消息', () => {
  const session = { msgs: [M('10', 'other', 'a'), M('11', 'me', 'b'), M('12', 'other', 'c'), M('13', 'sys', 'd')] };
  const fresh = newOtherMsgs(session, '10');
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].text, 'c');
  // 无 lastMid → 不返回(防首轮轰炸)
  assert.equal(newOtherMsgs(session, null).length, 0);
  assert.equal(newOtherMsgs(session, '').length, 0);
});

test('maxMid: 返回最大消息 id', () => {
  assert.equal(maxMid([M('5', 'me', 'a'), M('12', 'other', 'b'), M('9', 'sys', 'c')]), '12');
  assert.equal(maxMid([]), null);
});
