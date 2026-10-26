import { t } from './i18n';

function translated(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

/** Sidebar label for a config section. English stays the server label. */
export function configSectionLabel(key: string, fallback: string): string {
  return translated(`config.section.${key}`, fallback);
}

/** Sidebar heading for a config group. English stays the group name. */
export function configGroupLabel(group: string): string {
  return translated(`config.group.${group}`, group);
}

/** Intro under a config section. English stays the server help text. */
export function configSectionHelp(key: string, fallback: string): string {
  return translated(`config.section.${key}.help`, fallback);
}

function fieldKey(path: string): string | null {
  const leaf = path.split('.').pop();
  if (!leaf) return null;
  if (path.startsWith('providers.models.')) return `config.field.${leaf}`;
  if (path.startsWith('providers.tts.')) return `config.tts.${leaf}`;
  if (path.startsWith('providers.transcription.')) {
    const parts = path.slice('providers.transcription.'.length).split('.');
    const family = parts[0];
    const rest = parts.slice(2).join('.');
    if (!family || !rest) return null;
    if (family === 'local_whisper' || rest === 'model') return `config.stt.${family}.${rest}`;
    return `config.stt.${rest}`;
  }
  if (path.startsWith('model_routes.')) return `config.route.${leaf}`;
  if (path.startsWith('embedding_routes.')) return `config.embed.${leaf}`;
  if (path.startsWith('risk_profiles.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.risk.${rest}` : null;
  }
  if (path.startsWith('runtime_profiles.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.runtime.${rest}` : null;
  }
  if (path.startsWith('memory.')) {
    const rest = path.slice('memory.'.length);
    return rest ? `config.memory.${rest}` : null;
  }
  if (path.startsWith('skills.')) {
    const rest = path
      .slice('skills.'.length)
      .split('.')
      .filter((part) => !/^\d+$/.test(part))
      .join('.');
    return rest ? `config.skills.${rest}` : null;
  }
  if (path.startsWith('skill_bundles.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.skillbundle.${rest}` : null;
  }
  if (path.startsWith('mcp_bundles.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.mcpbundle.${rest}` : null;
  }
  if (path.startsWith('mcp.servers.')) {
    const rest = path.split('.').slice(3).join('.');
    return rest ? `config.mcpserver.${rest}` : null;
  }
  if (path.startsWith('channels.')) {
    const rest = path.slice('channels.'.length);
    if (!rest || rest.includes('.')) return null;
    return `config.channel.${rest}`;
  }
  if (path.startsWith('hardware.')) {
    const rest = path.slice('hardware.'.length);
    return rest ? `config.hardware.${rest}` : null;
  }
  if (path.startsWith('agents.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.agent.${rest}` : null;
  }
  if (path.startsWith('peer_groups.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.peergroup.${rest}` : null;
  }
  if (path.startsWith('tunnel.')) {
    const rest = path.slice('tunnel.'.length);
    return rest ? `config.tunnel.${rest}` : null;
  }
  if (path.startsWith('cron.')) {
    let rest = path.split('.').slice(2).join('.');
    if (rest.startsWith('cron_delivery.')) {
      rest = `delivery.${rest.slice('cron_delivery.'.length)}`;
    }
    return rest ? `config.cron.${rest}` : null;
  }
  if (path.startsWith('decision_models.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.decision.${rest}` : null;
  }
  if (path.startsWith('heartbeat.')) {
    const rest = path.slice('heartbeat.'.length);
    return rest ? `config.heartbeat.${rest}` : null;
  }
  if (path.startsWith('hooks.')) {
    const rest = path.slice('hooks.'.length);
    return rest ? `config.hooks.${rest}` : null;
  }
  if (path.startsWith('pacing.')) {
    const rest = path.slice('pacing.'.length);
    return rest ? `config.pacing.${rest}` : null;
  }
  if (path.startsWith('pipeline.')) {
    const rest = path.slice('pipeline.'.length);
    return rest ? `config.pipeline.${rest}` : null;
  }
  if (path.startsWith('query_classification.')) {
    const rest = path.slice('query_classification.'.length);
    return rest ? `config.query.${rest}` : null;
  }
  if (path.startsWith('reliability.')) {
    const rest = path.slice('reliability.'.length);
    return rest ? `config.reliability.${rest}` : null;
  }
  if (path.startsWith('runtime.') && !path.startsWith('runtime_profiles.')) {
    const rest = path.slice('runtime.'.length);
    return rest ? `config.runtime.${rest}` : null;
  }
  if (path.startsWith('scheduler.')) {
    const rest = path.slice('scheduler.'.length);
    return rest ? `config.scheduler.${rest}` : null;
  }
  if (path.startsWith('sop.')) {
    const rest = path.slice('sop.'.length);
    return rest ? `config.sop.${rest}` : null;
  }
  if (path.startsWith('verifiable_intent.')) {
    const rest = path.slice('verifiable_intent.'.length);
    return rest ? `config.vi.${rest}` : null;
  }
  if (path.startsWith('delegate.')) {
    const rest = path.slice('delegate.'.length);
    return rest ? `config.delegate.${rest}` : null;
  }
  if (path.startsWith('browser_delegate.')) {
    const rest = path.slice('browser_delegate.'.length);
    return rest ? `config.browser_delegate.${rest}` : null;
  }
  if (path.startsWith('text_browser.')) {
    const rest = path.slice('text_browser.'.length);
    return rest ? `config.text_browser.${rest}` : null;
  }
  if (path.startsWith('browser.')) {
    const rest = path.slice('browser.'.length);
    return rest ? `config.browser.${rest}` : null;
  }
  if (path.startsWith('http_request.')) {
    const rest = path.slice('http_request.'.length);
    return rest ? `config.http_request.${rest}` : null;
  }
  if (path.startsWith('image_gen.')) {
    const rest = path.slice('image_gen.'.length);
    return rest ? `config.image_gen.${rest}` : null;
  }
  if (path.startsWith('link_enricher.')) {
    const rest = path.slice('link_enricher.'.length);
    return rest ? `config.link_enricher.${rest}` : null;
  }
  if (path.startsWith('knowledge_bundles.')) {
    const rest = path.split('.').slice(2).join('.');
    return rest ? `config.knowledgebundle.${rest}` : null;
  }
  if (path.startsWith('knowledge.')) {
    const rest = path.slice('knowledge.'.length);
    return rest ? `config.knowledge.${rest}` : null;
  }
  if (path.startsWith('media_pipeline.')) {
    const rest = path.slice('media_pipeline.'.length);
    return rest ? `config.media_pipeline.${rest}` : null;
  }
  if (path.startsWith('multimodal.')) {
    const rest = path.slice('multimodal.'.length);
    return rest ? `config.multimodal.${rest}` : null;
  }
  if (path.startsWith('shell_tool.')) {
    const rest = path.slice('shell_tool.'.length);
    return rest ? `config.shelltool.${rest}` : null;
  }
  if (path.startsWith('project_intel.')) {
    const rest = path.slice('project_intel.'.length);
    return rest ? `config.projectintel.${rest}` : null;
  }
  if (path.startsWith('web_fetch.')) {
    const rest = path.slice('web_fetch.'.length);
    return rest ? `config.web_fetch.${rest}` : null;
  }
  if (path.startsWith('web_search.')) {
    const rest = path.slice('web_search.'.length);
    return rest ? `config.web_search.${rest}` : null;
  }
  if (path.startsWith('transcription.')) {
    const rest = path.slice('transcription.'.length);
    return rest ? `config.transcription.${rest}` : null;
  }
  if (path.startsWith('tts.')) {
    const rest = path.slice('tts.'.length);
    return rest ? `config.ttsconfig.${rest}` : null;
  }
  if (path.startsWith('plugins.')) {
    const rest = path.slice('plugins.'.length);
    return rest ? `config.plugin.${rest}` : null;
  }
  return null;
}

/** Label for a translated config field. Other sections keep the schema label. */
export function configFieldLabel(path: string, fallback: string): string {
  const key = fieldKey(path);
  return key ? translated(key, fallback) : fallback;
}

/** Help under a translated config field. Other sections keep the schema text. */
export function configFieldHelp(path: string, fallback: string | null): string | null {
  const key = fieldKey(path);
  if (!key) return fallback;
  const helpKey = `${key}.help`;
  const value = t(helpKey);
  return value === helpKey ? fallback : value;
}

/** Tab name emitted by the config schema, such as Connection / Model / Advanced. */
export function configTabLabel(tab: string): string {
  return translated(`config.tab.${tab}`, tab);
}

/** Enum option label. The stored value stays the variant name. */
export function configEnumLabel(path: string, variant: string): string {
  let key: string | null = null;
  if (path === 'hardware.transport') key = `config.hardware.transport.${variant}`;
  else if (path.startsWith('agents.') && path.endsWith('.memory.backend')) {
    key = `config.agent.memory.backend.${variant}`;
  }   else if (path.startsWith('agents.') && path.endsWith('.delegates.mode')) {
    key = `config.agent.delegates.mode.${variant}`;
  } else if (path.startsWith('peer_groups.') && path.endsWith('.output_modality')) {
    key = `config.peergroup.output_modality.${variant}`;
  } else if (path.startsWith('cron.') && path.endsWith('.shell_output_format')) {
    key = `config.cron.shell_output_format.${variant}`;
  } else if (path.startsWith('decision_models.') && path.endsWith('.provider')) {
    key = `config.decision.provider.${variant}`;
  } else if (path === 'runtime.kind') {
    key = `config.runtime.kind.${variant}`;
  } else if (path === 'sop.run_store_backend') {
    key = `config.sop.run_store_backend.${variant}`;
  } else if (path === 'sop.approval_mode') {
    key = `config.sop.approval_mode.${variant}`;
  } else if (path === 'sop.approval_timeout_action') {
    key = `config.sop.approval_timeout_action.${variant}`;
  } else if (path.startsWith('mcp.servers.') && path.endsWith('.transport')) {
    key = `config.mcpserver.transport.${variant}`;
  } else if (path === 'web_fetch.firecrawl.mode') {
    key = `config.web_fetch.firecrawl.mode.${variant}`;
  }
  return key ? translated(key, variant) : variant;
}

/** Status badge such as configured / active. The raw value stays the lookup key. */
export function configBadgeLabel(badge: string): string {
  return translated(`config.badge.${badge.replace(/\s+/g, '_')}`, badge);
}

const PICKER_NOTES: Record<string, string> = {
  'Local — no API key required': 'config.picker.local_no_key',
  'Localhost only — no public tunnel.': 'config.picker.tunnel.none_note',
};

/** Picker row title. English stays the server label when no translation exists. */
export function configPickerItemLabel(section: string, key: string, fallback: string): string {
  return translated(`config.picker.${section}.${key}`, fallback);
}

/** Short note under a provider in the add-provider picker. */
export function configPickerNote(text: string): string {
  const key = PICKER_NOTES[text];
  return key ? translated(key, text) : text;
}
