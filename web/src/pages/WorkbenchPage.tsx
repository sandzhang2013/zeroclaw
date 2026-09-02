import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBoundary } from '@/App';
import ChatWorkspace from '@/pages/ChatWorkspace';
import { WorkbenchLogin } from '@/components/WorkbenchLogin';
import { t } from '@/lib/i18n';
import {
  clearMockUser,
  resolveWorkbenchUser,
  saveMockUser,
  type PlatformUser,
} from '@/lib/platformUser';

/** Full-viewport three-column workbench, no dashboard rail or header. */
export default function WorkbenchPage() {
  const { alias } = useParams<{ alias: string }>();
  const initialAlias = alias ? decodeURIComponent(alias) : 'deepseek';
  const [user, setUser] = useState<PlatformUser | null>(() => resolveWorkbenchUser());

  useEffect(() => {
    if (user?.source === 'mock') saveMockUser(user);
  }, [user]);

  useEffect(() => {
    document.title = t('workbench.brand');
  }, []);

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-pc-base text-pc-text">
      <ErrorBoundary>
        <ChatWorkspace
          key={user.userId}
          initialAlias={initialAlias}
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
