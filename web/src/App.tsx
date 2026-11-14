import {
  Component,
  createContext,
  useContext,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";

import { loadLocale, saveLocale } from "./contexts/ThemeContext";
import { ReauthPrompt } from "./components/auth/ReauthPrompt";
import { SignInScreen } from "./components/auth/SignInScreen";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { DraftContext, useDraftStore } from "./hooks/useDraft";
import { getQuickstartState } from "./lib/api";
import { ConfigDraftProvider } from "./lib/draftStore";
import { resolveStoredLocale, setLocale } from "./lib/i18n";
import { shouldSkipPairing } from "./lib/skipPairing";
import { Router } from "./router/router";
import { dropChatHistoryCache } from "./lib/localStorageWrite";

// Locale context
interface LocaleContextType {
  locale: string;
  setAppLocale: (locale: string) => void;
}

export const LocaleContext = createContext<LocaleContextType>({
  locale: "zh",
  setAppLocale: () => {},
});

export const useLocaleContext = () => useContext(LocaleContext);

// ---------------------------------------------------------------------------
// Error boundary — catches render crashes and shows a recoverable message
// instead of a black screen
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidMount() {
    if (!this.state.error) sessionStorage.removeItem("zeroclaw-quota-cleared");
  }

  componentDidUpdate() {
    if (!this.state.error) sessionStorage.removeItem("zeroclaw-quota-cleared");
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ZeroClaw] Render error:", error, info.componentStack);
    // Stale-chunk recovery: when Vite rebuilds, the loaded index.html
    // still references the previous chunk hashes. A dynamic import for
    // a lazy route then 404s with "error loading dynamically imported
    // module". Reload once so the user gets the new index.html and the
    // current chunk hashes; the sessionStorage marker prevents reload
    // loops if reload doesn't actually help.
    if (
      isChunkLoadError(error) &&
      !sessionStorage.getItem("zeroclaw-chunk-reloaded")
    ) {
      sessionStorage.setItem("zeroclaw-chunk-reloaded", "1");
      window.location.reload();
      return;
    }
    if (isStorageQuotaError(error) && !sessionStorage.getItem("zeroclaw-quota-cleared")) {
      sessionStorage.setItem("zeroclaw-quota-cleared", "1");
      dropChatHistoryCache();
      window.location.reload();
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6">
          <div
            className="card p-6 w-full max-w-lg"
            style={{ borderColor: "var(--color-status-error-alpha-30)" }}
          >
            <h2
              className="text-lg font-semibold mb-2"
              style={{ color: "var(--color-status-error)" }}
            >
              Something went wrong
            </h2>
            <p
              className="text-sm mb-4"
              style={{ color: "var(--pc-text-muted)" }}
            >
              A render error occurred. Check the browser console for details.
            </p>
            <pre
              className="text-xs rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono"
              style={{
                background: "var(--pc-bg-base)",
                color: "var(--color-status-error)",
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              onClick={() => {
                sessionStorage.removeItem("zeroclaw-chunk-reloaded");
                if (this.state.error && (isChunkLoadError(this.state.error) || isStorageQuotaError(this.state.error))) {
                  if (isStorageQuotaError(this.state.error)) dropChatHistoryCache();
                  // Chrome caches a failed `import()` for the page lifetime.
                  // Clearing React state is not enough; refetch the module.
                  window.location.reload();
                  return;
                }
                this.setState({ error: null });
              }}
              className="btn-electric mt-6 px-4 py-2 text-sm font-medium"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function isStorageQuotaError(error: Error): boolean {
  const message = error?.message ?? "";
  return error?.name === "QuotaExceededError"
    || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || message.includes("exceeded the quota");
}

function isChunkLoadError(error: Error): boolean {
  const m = error?.message ?? "";
  return (
    m.includes("dynamically imported module") ||
    m.includes("Failed to fetch dynamically") ||
    m.includes("Importing a module script failed") ||
    error?.name === "ChunkLoadError"
  );
}

function AppContent() {
  const {
    isAuthenticated,
    requiresPairing,
    loading,
    pair,
    logout,
    providers,
    viaRelay,
    signInMethods,
    retrySignInMethods,
    signIn,
    signOutNotice,
  } = useAuth();
  const location = useLocation();
  const [locale, setLocaleState] = useState(loadLocale());
  const draftStore = useDraftStore();
  setLocale(resolveStoredLocale(locale));
  // Vite and BFF workbench use identity, not device pairing. Skip when
  // `npm run dev`, the path is `/workbench` (with or without `/hbcdcagent`),
  // or the BFF injected `__ZEROCLAW_PLATFORM_USER__`. Direct daemon
  // dashboard on :42617 still requires pairing.
  const skipPairing = shouldSkipPairing({
    dev: import.meta.env.DEV,
    pathname: location.pathname,
    platformUser: window.__ZEROCLAW_PLATFORM_USER__,
  });

  const setAppLocale = (newLocale: string) => {
    const next = resolveStoredLocale(newLocale);
    setLocaleState(next);
    setLocale(next);
    saveLocale(next);
  };

  useEffect(() => {
    window.addEventListener("zeroclaw-unauthorized", logout);
    return () => window.removeEventListener("zeroclaw-unauthorized", logout);
  }, [logout]);

  if (loading && !skipPairing) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center"
        style={{ background: "var(--pc-bg-base)" }}
      >
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          <div
            className="h-10 w-10 border-2 rounded-full animate-spin"
            style={{
              borderColor: "var(--pc-border)",
              borderTopColor: "var(--pc-accent)",
            }}
          />
          <p className="text-sm" style={{ color: "var(--pc-text-muted)" }}>
            Connecting...
          </p>
        </div>
      </div>
    );
  }

  if (!skipPairing && !isAuthenticated && requiresPairing) {
    return (
      <SignInScreen
        onPair={pair}
        providers={providers}
        onSignIn={signIn}
        notice={signOutNotice}
        viaRelay={viaRelay}
        methods={signInMethods}
        onRetryMethods={retrySignInMethods}
      />
    );
  }

  return (
    <DraftContext.Provider value={draftStore}>
      <ConfigDraftProvider>
        <LocaleContext.Provider value={{ locale, setAppLocale }}>
          <FreshInstallRedirect />
          <ReauthPrompt />
          <Router />
        </LocaleContext.Provider>
      </ConfigDraftProvider>
    </DraftContext.Provider>
  );
}

// Redirects fresh installs (no agents yet, Quickstart never completed)
// from `/dashboard` to `/quickstart`. The daemon always writes a default
// config.toml on init, so file existence isn't the right signal —
// we ask the gateway via /api/quickstart/state which reports
// quickstart_completed plus the live agents list.
//
// Fires once per session. Only redirects when the user lands at `/dashboard`
// — `/` is the workbench. Manual navigation to other routes is left alone.
function FreshInstallRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (checked) return;
    setChecked(true);
    if (location.pathname !== "/dashboard") return;
    void getQuickstartState()
      .then((state) => {
        if (!state.quickstart_completed && state.agents.length === 0) {
          navigate("/quickstart", { replace: true });
        }
      })
      .catch(() => {
        // Status check failed (network blip, gateway hiccup); the
        // dashboard renders normally as the safe default.
      });
  }, [checked, location.pathname, navigate]);

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </AuthProvider>
  );
}
