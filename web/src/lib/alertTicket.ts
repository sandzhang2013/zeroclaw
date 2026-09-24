/** 智能预警跳转 URL 上的一次性票据。验票在 BFF，这里只负责发现参数和文案。 */

export interface AlertTicketQuery {
  clientId: string;
  verifyData: string;
}

export function readAlertTicketQuery(search: string): AlertTicketQuery | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const clientId = (params.get('clientId') ?? '').trim();
  const verifyData = (params.get('verifyData') ?? '').trim();
  if (!clientId || !verifyData) return null;
  return { clientId, verifyData };
}

/** 去掉票据参数，保留其余 query。无剩余参数时返回空串。 */
export function stripAlertTicketSearch(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  params.delete('clientId');
  params.delete('verifyData');
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function alertTicketErrorText(code: number): string {
  switch (code) {
    case 40001:
      return '接入未授权，请联系管理员';
    case 40002:
      return '链接已过期，请从智能预警系统重新进入';
    case 40003:
      return '凭证无效，请从智能预警系统重新进入';
    case 40004:
      return '链接已失效，请重新进入';
    case 40005:
      return '参数错误';
    case 40006:
      return '操作过于频繁，请稍后再试';
    default:
      return '凭证无效，请从智能预警系统重新进入';
  }
}
