import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBoundary } from '@/App';
import ChatWorkspace from '@/pages/ChatWorkspace';
import { WorkbenchLogin } from '@/components/WorkbenchLogin';
import { t } from '@/lib/i18n';
import { getStatus } from '@/lib/api';
import { resolveWorkbenchAgentAlias } from '@/lib/workbenchAgent';
import {
  clearMockUser,
  resolveWorkbenchUser,
  saveMockUser,
  type PlatformUser,
} from '@/lib/platformUser';

/** Full-viewport three-column workbench, no dashboard rail or header. */
export default function WorkbenchPage() {
  const { alias } = useParams<{ alias: string }>();
  const requested = alias ? decodeURIComponent(alias) : undefined;
  const [user, setUser] = useState<PlatformUser | null>(() => resolveWorkbenchUser());
  const [agentAlias, setAgentAlias] = useState<string | null>(null);

  useEffect(() => {
    if (user?.source === 'mock') saveMockUser(user);
  }, [user]);

  useEffect(() => {
    document.title = t('workbench.brand');
  }, []);

  useEffect(() => {
    if (!user) {
      setAgentAlias(null);
      return;
    }
    let cancelled = false;
    getStatus()
      .then((status) => {
        if (!cancelled) {
          setAgentAlias(resolveWorkbenchAgentAlias(requested, status.agents ?? []));
        }
      })
      .catch(() => {
        if (!cancelled) setAgentAlias(resolveWorkbenchAgentAlias(requested, []));
      });
    return () => {
      cancelled = true;
    };
  }, [user, requested]);

  const enter = (next: PlatformUser) => {
    if (next.source === 'mock') saveMockUser(next);
    setUser(next);
  };

  const switchUser = () => {
    clearMockUser();
    setUser(null);
  };

  if (!user) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-pc-base text-pc-text">
        <WorkbenchLogin onSelect={enter} />
      </div>
    );
  }

  if (!agentAlias) {
    return (
      <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-pc-base text-pc-text-muted">
        <div
          className="h-8 w-8 rounded-full animate-spin border-2"
          style={{ borderColor: 'var(--pc-border)', borderTopColor: 'var(--pc-accent)' }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-pc-base text-pc-text">
      <ErrorBoundary>
        <ChatWorkspace
          key={`${user.userId}:${agentAlias}`}
          initialAlias={agentAlias}
          userId={user.userId}
          userName={user.displayName}
          userRole={user.role}
          userRegion={user.region}
          onSwitchUser={user.source === 'mock' ? switchUser : undefined}
        />
      </ErrorBoundary>
    </div>
  );
}
