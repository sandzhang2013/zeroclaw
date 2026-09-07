import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BarChart3,
  Building2,
  ClipboardList,
  FileText,
  Map,
  Search,
  ShieldAlert,
  Syringe,
} from 'lucide-react';
import { getLocale, type Locale } from '@/lib/i18n';

export type WorkbenchHomeCapKind = 'chat' | 'outline';

export interface WorkbenchHomeCapView {
  id: string;
  icon: string;
  kind: WorkbenchHomeCapKind | string;
  label: string;
  prompt: string;
}

export interface WorkbenchHomeTabView {
  id: string;
  label: string;
  caps: WorkbenchHomeCapView[];
}

export interface WorkbenchHomeCatalog {
  source: 'config' | 'builtin' | string;
  tabs: WorkbenchHomeTabView[];
}

const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  syringe: Syringe,
  search: Search,
  'building-2': Building2,
  'bar-chart-3': BarChart3,
  'shield-alert': ShieldAlert,
  map: Map,
  'file-text': FileText,
  'clipboard-list': ClipboardList,
};

export function homeCapIcon(id: string): LucideIcon {
  return ICONS[id] ?? FileText;
}

/** Last-resort catalog when GET /api/workbench/home is unreachable. */
export function fallbackHomeCatalog(locale: Locale = getLocale()): WorkbenchHomeCatalog {
  const zh = locale === 'zh';
  return {
    source: 'builtin',
    tabs: [
      {
        id: 'query',
        label: zh ? '数据查询' : 'Query',
        caps: [
          {
            id: 'outbreak',
            icon: 'activity',
            kind: 'chat',
            label: zh ? '疫情概况' : 'Outbreak overview',
            prompt: zh
              ? '帮我查询并概述近期全省传染病疫情情况。'
              : 'Query and summarize recent infectious-disease conditions across the province.',
          },
          {
            id: 'vaccine',
            icon: 'syringe',
            kind: 'chat',
            label: zh ? '疫苗覆盖' : 'Vaccination coverage',
            prompt: zh
              ? '帮我查询并解读近期疫苗接种覆盖率。'
              : 'Look up and explain recent vaccination coverage.',
          },
          {
            id: 'cases',
            icon: 'search',
            kind: 'chat',
            label: zh ? '病例检索' : 'Case search',
            prompt: zh
              ? '帮我按地区和时间检索病例数据并给出要点。'
              : 'Search cases by region and time, then highlight the key points.',
          },
          {
            id: 'orgs',
            icon: 'building-2',
            kind: 'chat',
            label: zh ? '机构名单' : 'Facility list',
            prompt: zh
              ? '帮我查询相关疾控与医疗机构名单并整理成表。'
              : 'Look up CDC and medical facilities and organize them into a table.',
          },
        ],
      },
      {
        id: 'monitor',
        label: zh ? '监测分析' : 'Surveillance',
        caps: [
          {
            id: 'trend',
            icon: 'bar-chart-3',
            kind: 'chat',
            label: zh ? '趋势分析' : 'Trend analysis',
            prompt: zh
              ? '根据监测数据帮我分析近期疫情趋势并解读关键变化。'
              : 'Analyze recent epidemic trends from surveillance data and explain key changes.',
          },
          {
            id: 'cluster',
            icon: 'shield-alert',
            kind: 'chat',
            label: zh ? '聚集性疫情' : 'Cluster events',
            prompt: zh
              ? '帮我梳理近期聚集性疫情情况并提示风险点。'
              : 'Summarize recent cluster outbreaks and flag risk points.',
          },
          {
            id: 'alert',
            icon: 'activity',
            kind: 'chat',
            label: zh ? '预警信号' : 'Alert signals',
            prompt: zh
              ? '帮我分析近期预警信号数据并给出研判建议。'
              : 'Analyze recent alert signals and provide an assessment.',
          },
          {
            id: 'region',
            icon: 'map',
            kind: 'chat',
            label: zh ? '地区对比' : 'Regional compare',
            prompt: zh
              ? '帮我对比各地市监测指标差异并标出异常地区。'
              : 'Compare prefecture-level indicators and mark unusual areas.',
          },
        ],
      },
      {
        id: 'report',
        label: zh ? '报告撰写' : 'Reports',
        caps: [
          {
            id: 'brief',
            icon: 'file-text',
            kind: 'outline',
            label: zh ? '工作简报' : 'Work brief',
            prompt: zh
              ? '帮我起草一份疾控工作简报提纲，结构清晰、重点突出。'
              : 'Draft a CDC work-brief outline with a clear structure and key points.',
          },
          {
            id: 'weekly',
            icon: 'clipboard-list',
            kind: 'outline',
            label: zh ? '监测周报' : 'Weekly report',
            prompt: zh
              ? '帮我起草本周传染病监测周报提纲。'
              : 'Draft an outline for this week’s infectious-disease surveillance report.',
          },
          {
            id: 'special',
            icon: 'file-text',
            kind: 'outline',
            label: zh ? '专题报告' : 'Special report',
            prompt: zh
              ? '帮我起草一份专题分析报告提纲，含背景、发现和建议。'
              : 'Draft a special-analysis report outline covering background, findings, and recommendations.',
          },
          {
            id: 'minutes',
            icon: 'clipboard-list',
            kind: 'outline',
            label: zh ? '会议纪要' : 'Meeting notes',
            prompt: zh
              ? '帮我按疾控例会口径整理一份会议纪要提纲。'
              : 'Draft a meeting-minutes outline in CDC standing-meeting style.',
          },
        ],
      },
    ],
  };
}
