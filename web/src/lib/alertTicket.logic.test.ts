import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertTicketErrorText,
  readAlertTicketQuery,
  stripAlertTicketSearch,
} from './alertTicket.ts';

test('reads clientId and verifyData', () => {
  const q = readAlertTicketQuery('?clientId=CDSS-B-ZJJK-001&verifyData=abc&x=1');
  assert.deepEqual(q, { clientId: 'CDSS-B-ZJJK-001', verifyData: 'abc' });
  assert.equal(readAlertTicketQuery('?clientId=only'), null);
  assert.equal(readAlertTicketQuery(''), null);
});

test('strips ticket params and keeps the rest', () => {
  assert.equal(
    stripAlertTicketSearch('?clientId=a&verifyData=b&tab=1'),
    '?tab=1',
  );
  assert.equal(stripAlertTicketSearch('?clientId=a&verifyData=b'), '');
});

test('maps ticket error codes', () => {
  assert.equal(alertTicketErrorText(40002), '链接已过期，请从智能预警系统重新进入');
  assert.equal(alertTicketErrorText(40004), '链接已失效，请重新进入');
  assert.match(alertTicketErrorText(0), /凭证无效/);
});
