import { useEffect, useState } from 'react';
import { getQuickPrompts, putQuickPrompts, type QuickPromptAccount } from '@/lib/api';
import {
  QUICK_PROMPTS_CHANGED,
  clearQuickPromptsDirty,
  loadQuickPrompts,
  markQuickPromptsDirty,
  quickPromptsDirty,
  reconcileQuickPromptStore,
  saveQuickPrompts,
  splitQuickPrompts,
  type QuickPrompt,
  type QuickPromptStore,
} from '@/lib/quickPrompts';

let revision = 0;
let chain: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function accountStore(account: QuickPromptAccount): QuickPromptStore {
  return {
    personal: account.personal_stored ? account.personal : null,
    shared: account.shared_stored ? account.shared : null,
  };
}

/** Write the browser copy immediately, then the account copy. A failed upload stays dirty. */
export function persistQuickPrompts(
  userId: string | undefined,
  prompts: QuickPrompt[],
): Promise<void> {
  const rev = ++revision;
  markQuickPromptsDirty(userId);
  saveQuickPrompts(userId, prompts);
  return enqueue(async () => {
    if (rev !== revision) return;
    try {
      await putQuickPrompts(splitQuickPrompts(prompts));
      if (rev === revision) clearQuickPromptsDirty(userId);
    } catch {
      /* the next open uploads this browser's copy */
    }
  });
}

/** Browser copy first, then the account copy when the gateway answers. */
export function useQuickPrompts(userId?: string): QuickPrompt[] {
  const [prompts, setPrompts] = useState<QuickPrompt[]>(() => loadQuickPrompts(userId));

  useEffect(() => {
    const apply = () => setPrompts(loadQuickPrompts(userId));
    apply();
    window.addEventListener(QUICK_PROMPTS_CHANGED, apply);
    const seen = revision;
    let cancelled = false;
    void enqueue(async () => {
      if (cancelled || seen !== revision) return;
      try {
        if (quickPromptsDirty(userId)) {
          await putQuickPrompts(splitQuickPrompts(loadQuickPrompts(userId)));
          if (!cancelled && seen === revision) clearQuickPromptsDirty(userId);
          return;
        }
        const account = await getQuickPrompts();
        if (cancelled || seen !== revision) return;
        const next = reconcileQuickPromptStore(loadQuickPrompts(userId), accountStore(account));
        if (cancelled || seen !== revision) return;
        saveQuickPrompts(userId, next.prompts);
        if (next.upload && !cancelled && seen === revision) {
          await putQuickPrompts(splitQuickPrompts(next.prompts));
        }
      } catch {
        /* keep the browser copy */
      }
    });
    return () => {
      cancelled = true;
      window.removeEventListener(QUICK_PROMPTS_CHANGED, apply);
    };
  }, [userId]);

  return prompts;
}
