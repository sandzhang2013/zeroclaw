import { MapPin } from 'lucide-react';
import { t } from '@/lib/i18n';
import { basePath } from '@/lib/basePath';
import {
  MOCK_USERS,
  roleI18nKey,
  type CanonicalRole,
  type PlatformUser,
} from '@/lib/platformUser';

function roleTone(role: CanonicalRole): string {
  if (role === '高级用户') return 'text-pc-accent border-pc-accent/30 bg-pc-accent/10';
  if (role === '运维') return 'text-[var(--color-status-warning)] border-[var(--color-status-warning-alpha-20)] bg-[var(--color-status-warning-alpha-05)]';
  return 'text-pc-text-muted border-pc-border bg-pc-elevated';
}

function initial(name: string): string {
  return name.trim().slice(0, 1) || '?';
}

export function WorkbenchLogin({ onSelect }: { onSelect: (user: PlatformUser) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-12">
      <div className="w-full max-w-[36rem]">
        <div className="mb-8 flex flex-col items-center text-center">
          <img
            src={`${basePath}/_app/logo.png`}
            alt=""
            className="mb-4 size-14 object-contain"
          />
          <h1 className="text-2xl font-bold tracking-tight text-pc-text">{t('workbench.brand')}</h1>
          <p className="mt-2 text-lg font-medium text-pc-text">{t('workbench.login_title')}</p>
          <p className="mt-2 max-w-md text-sm leading-6 text-pc-text-muted">
            {t('workbench.login_subtitle')}
          </p>
        </div>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MOCK_USERS.map((user) => (
            <li key={user.userId}>
              <button
                type="button"
                onClick={() => onSelect(user)}
                className="group flex w-full flex-col gap-3 rounded-2xl border border-pc-border bg-pc-elevated p-4 text-left transition-colors hover:border-pc-accent/40 hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              >
                <div className="flex items-start gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-pc-base text-base font-semibold text-pc-text">
                    {initial(user.displayName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-pc-text">{user.displayName}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] leading-none ${roleTone(user.role)}`}>
                        {t(roleI18nKey(user.role))}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-pc-text-muted">{user.org}</p>
                  </div>
                </div>
                <p className="flex items-center gap-1 text-xs text-pc-text-faint">
                  <MapPin className="size-3 shrink-0" />
                  {user.region}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
