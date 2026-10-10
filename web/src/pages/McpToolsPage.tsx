import { basePath } from '@/lib/basePath';
import { t } from '@/lib/i18n';

/** Admin shell around the loopback MCP tool page. The iframe URL is the
 *  prefixed path the BFF (or Vite) forwards to 127.0.0.1:9100. */
export default function McpToolsPage() {
  const src = `${basePath}/mcp-tools/`;
  return (
    <iframe
      title={t('nav.mcp_tools')}
      src={src}
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
