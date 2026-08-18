import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBoundary } from '@/App';
import ChatWorkspace from '@/pages/ChatWorkspace';
import { t } from '@/lib/i18n';

/** Full-viewport three-column workbench, no dashboard rail or header. */
export default function WorkbenchPage() {
  const { alias } = useParams<{ alias: string }>();
  const initialAlias = alias ? decodeURIComponent(alias) : 'deepseek';

  useEffect(() => {
    document.title = `${t('workbench.page_title')} — ZeroClaw`;
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-pc-base text-pc-text">
      <ErrorBoundary>
        <ChatWorkspace initialAlias={initialAlias} />
      </ErrorBoundary>
    </div>
  );
}
