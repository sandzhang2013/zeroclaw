import assert from 'node:assert/strict';
import test from 'node:test';

import { feedbackReviewCsv, type FeedbackExportLabels } from './feedbackExport.ts';

const labels: FeedbackExportLabels = {
  turns: '总轮数',
  like: '喜欢',
  dislike: '不喜欢',
  unrated: '未评价',
  time: '时间',
  user: '用户',
  verdict: '结论',
  reason: '原因',
  comment: '意见',
  session: '会话',
  sessionId: '会话id',
  excerpt: '回复摘要',
};

test('feedbackReviewCsv keeps the totals and escapes commas and quotes', () => {
  const csv = feedbackReviewCsv(
    { coverage: { turns: 21, like: 2, dislike: 1, unrated: 18 } },
    [{
      updatedAt: '2026-10-10 07:06',
      userId: 'chenmin',
      verdict: '不喜欢',
      reason: '数据不对',
      comment: '希望,只回答好',
      sessionTitle: '分析,对比',
      sessionId: 'sess-1',
      excerpt: 'line\nnext',
    }],
    labels,
  );
  assert.match(csv, /^总轮数,21\n喜欢,2\n不喜欢,1\n未评价,18\n\n/);
  assert.match(csv, /"分析,对比"/);
  assert.match(csv, /"希望,只回答好"/);
  assert.match(csv, /"line\nnext"/);
  assert.match(csv, /sess-1/);
});
