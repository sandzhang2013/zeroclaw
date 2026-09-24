import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { alertTicketErrorText, readAlertTicketQuery, stripAlertTicketSearch } from './lib/alertTicket';
import { isEmbeddedFrame } from './lib/iframeAsk';
import { rememberEmbedSession } from './lib/iframeSession';
import { basePath, gatewayUrl } from './lib/basePath';
import { installStructuredClonePolyfill } from './lib/browserSupport';
import './index.css';

installStructuredClonePolyfill(window);

function mountApp() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/* basePath is injected by the Rust gateway at serve time for reverse-proxy prefix support. */}
      <BrowserRouter basename={basePath || '/'}>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

function showTicketError(code: number) {
  const root = document.getElementById('root');
  if (!root) return;
  root.replaceChildren();
  const box = document.createElement('div');
  box.style.cssText = 'font-family:sans-serif;padding:48px 24px;max-width:520px;margin:0 auto;line-height:1.6';
  const title = document.createElement('h1');
  title.textContent = '无法进入智算疾控';
  title.style.cssText = 'font-size:20px;margin:0 0 12px';
  const msg = document.createElement('p');
  msg.textContent = alertTicketErrorText(code);
  box.append(title, msg);
  root.append(box);
}

async function boot() {
  const ticket = readAlertTicketQuery(window.location.search);
  if (!ticket) {
    mountApp();
    return;
  }
  try {
    const embedded = isEmbeddedFrame(window);
    const res = await fetch(gatewayUrl('/sso/auth/verify'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(embedded ? { 'x-hbcdcagent-embed': '1' } : {}),
      },
      body: JSON.stringify({ clientId: ticket.clientId, verifyData: ticket.verifyData }),
    });
    const body = (await res.json()) as { code?: number; data?: { sessionId?: string } };
    const code = typeof body.code === 'number' ? body.code : 40003;
    if (code !== 0) {
      showTicketError(code);
      return;
    }
    if (embedded) rememberEmbedSession(body.data?.sessionId);
    const next =
      window.location.pathname + stripAlertTicketSearch(window.location.search) + window.location.hash;
    window.history.replaceState(null, '', next);
    mountApp();
  } catch {
    showTicketError(40003);
  }
}

void boot();
