import assert from 'node:assert/strict';
import test from 'node:test';

async function loadValidationWarningMessage() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __ZEROCLAW_BASE__: '' },
  });
  const { setLocale } = await import('./i18n.ts');
  const { validationWarningMessage } = await import('./validationWarnings.ts');
  delete (globalThis as { window?: unknown }).window;
  return { setLocale, validationWarningMessage };
}

test('known config warnings resolve through the dashboard catalog', async () => {
  const { setLocale, validationWarningMessage } = await loadValidationWarningMessage();
  setLocale('zh');
  const auditMessage = validationWarningMessage({
    code: 'security_audit_disabled_drops_certificate_record',
    message: 'unlocalized audit fallback',
    path: 'security.audit.enabled',
  });

  assert.match(auditMessage, /证书签发和续期不会留下审计记录/);
  assert.match(auditMessage, /命令执行本身都不会记入审计/);
  assert.doesNotMatch(auditMessage, /unlocalized audit fallback/);

  setLocale('en');
  const english = validationWarningMessage({
    code: 'security_audit_disabled_drops_certificate_record',
    message: 'unlocalized audit fallback',
    path: 'security.audit.enabled',
  });
  assert.match(english, /certificate issuance and renewal have no audit-log record/i);
  assert.match(english, /command execution is not audited/i);
  setLocale('zh');
});

test('unknown config warnings retain the API fallback message', async () => {
  const { validationWarningMessage } = await loadValidationWarningMessage();
  const message = validationWarningMessage({
    code: 'future_warning',
    message: 'future fallback',
    path: 'future.path',
  });

  assert.equal(message, 'future fallback');
});
