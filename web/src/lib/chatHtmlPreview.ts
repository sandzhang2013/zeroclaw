/** Pull fenced `html` blocks out of assistant markdown so they can render as a chart preview. */

const HTML_FENCE_RE = /^```(?:html|htm)\s*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/**
 * Opaque-origin iframe flags for untrusted HTML.
 * Scripts stay on so Chart.js / ECharts can paint; popups, forms, and
 * same-origin are off so a preview cannot open an unsandboxed window or
 * read the workbench origin.
 */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

/** Document policy for srcDoc / workspace HTML. `sandbox` is HTTP-header-only. */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

export function splitChatHtmlBlocks(content: string): { markdown: string; htmlBlocks: string[] } {
  const htmlBlocks: string[] = [];
  const markdown = content.replace(HTML_FENCE_RE, (_whole, body: string) => {
    const html = body.trim();
    if (html) htmlBlocks.push(html);
    return '\n';
  });
  return { markdown: markdown.trim(), htmlBlocks };
}

function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
}

/** Prepend our CSP so it intersects any policy the untrusted HTML already set. */
function injectCspMeta(html: string): string {
  const meta = cspMetaTag();
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  }
  return `${meta}${html}`;
}

/** Wrap a fragment so Chart.js / ECharts snippets still paint in an iframe. */
export function htmlPreviewSrcDoc(html: string): string {
  if (/<!doctype/i.test(html) || /<html[\s>]/i.test(html)) {
    return injectCspMeta(html);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${cspMetaTag()}<style>html,body{margin:0;padding:8px;background:#fff;}</style></head><body>${html}</body></html>`;
}
