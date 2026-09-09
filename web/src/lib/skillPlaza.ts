/** Shared skill-plaza catalog. Install copies a template into the caller's personal skills. */

import type { Locale } from './locale.ts';

export type PlazaCategory = 'recommended';

export interface PlazaSkill {
  id: string;
  category: PlazaCategory;
  title_zh: string;
  title_en: string;
  description_zh: string;
  description_en: string;
  body_zh: string;
  body_en: string;
}

export interface PlazaSkillView {
  id: string;
  category: PlazaCategory;
  title: string;
  description: string;
  body: string;
}

/** Builtin shared skills. Append here when more common skills are ready. */
export const PLAZA_SKILLS: PlazaSkill[] = [
  {
    id: 'infectious-weekly',
    category: 'recommended',
    title_zh: '传染病周报',
    title_en: 'Weekly infectious-disease brief',
    description_zh: '按近一周法定传染病报告整理发病数、同比环比，并标出需关注病种。',
    description_en: 'Summarize last week’s notifiable-disease counts, week-on-week change, and diseases to watch.',
    body_zh: [
      '# 传染病周报',
      '',
      '## When to use',
      '用户要看本周或近一周传染病报告、发病数变化、需要关注的病种。',
      '',
      '## How to do it',
      '1. 先查近 7 天（或用户指定区间）的传染病报告发病数，默认按用户地区；运维未点名城市时用全省。',
      '2. 对比上一同等长度区间，标出升幅较大或连续上升的病种。',
      '3. 用表格列出病种、本期数、上期数、变化；必要时出趋势图。',
      '4. 结尾用三句话说明：总体、需关注病种、建议下一步查什么。不要编造未查出的数字。',
    ].join('\n'),
    body_en: [
      '# Weekly infectious-disease brief',
      '',
      '## When to use',
      'The user wants last week’s notifiable-disease counts, change vs the prior week, or diseases to watch.',
      '',
      '## How to do it',
      '1. Query the last 7 days (or the user’s range). Default to the user’s region; ops without a named city use the whole province.',
      '2. Compare the previous equal window. Flag large increases or consecutive rises.',
      '3. Table: disease, this period, last period, change. Chart if it helps.',
      '4. Close with three sentences: overall, watchlist, next query. Do not invent numbers.',
    ].join('\n'),
  },
  {
    id: 'flu-trend',
    category: 'recommended',
    title_zh: '流感趋势解读',
    title_en: 'Influenza trend reading',
    description_zh: '结合流感样病例和病原监测，说明近期流感活动水平和优势型别。',
    description_en: 'Read ILI and pathogen surveillance together: activity level and dominant type.',
    body_zh: [
      '# 流感趋势解读',
      '',
      '## When to use',
      '用户问流感是否上升、哪一型为主、门急诊流感样病例或病原阳性情况。',
      '',
      '## How to do it',
      '1. 同时看流感样病例（ILI）和流感病原分型，不要只报一个指标。',
      '2. 用近 4–8 周说明趋势：上升、平台还是回落。',
      '3. 点明优势型别（甲型/乙型及亚型，以监测结果为准）。',
      '4. 地区默认登录用户所在地；不要把外地数据说成本地。数据缺失时直接说明缺哪一项。',
    ].join('\n'),
    body_en: [
      '# Influenza trend reading',
      '',
      '## When to use',
      'The user asks whether flu is rising, which type dominates, or about ILI / pathogen results.',
      '',
      '## How to do it',
      '1. Use ILI and pathogen typing together. Never report only one.',
      '2. Cover the last 4–8 weeks: rising, plateau, or falling.',
      '3. Name the dominant type/subtype from surveillance, not guesswork.',
      '4. Default to the signed-in region. Say which series is missing if a feed is empty.',
    ].join('\n'),
  },
  {
    id: 'two-week-compare',
    category: 'recommended',
    title_zh: '近两周对比',
    title_en: 'Two-week comparison',
    description_zh: '对比最近两周传染病报告发病数，找出变化最大的病种。',
    description_en: 'Compare the last two weeks of notifiable-disease counts and rank the largest changes.',
    body_zh: [
      '# 近两周对比',
      '',
      '## When to use',
      '用户要「近两周对比」「这周比上周」「哪些病种变化大」。',
      '',
      '## How to do it',
      '1. 以自然周或用户指定的两个 7 天窗口对比发病数。',
      '2. 按变化绝对值或升幅排序，列出前若干病种，同时保留下降较多的病种。',
      '3. 对升幅大的病种补一句可能原因（季节性、报告延迟、聚集性），标成推测而非结论。',
      '4. 给出一张对比表或柱状图；数字必须来自查询结果。',
    ].join('\n'),
    body_en: [
      '# Two-week comparison',
      '',
      '## When to use',
      'The user wants this week vs last week, or the diseases with the largest change.',
      '',
      '## How to do it',
      '1. Compare two 7-day windows (calendar weeks or the user’s dates).',
      '2. Rank by absolute or relative change. Include both rises and large drops.',
      '3. One cautious sentence on possible reasons (season, reporting lag, clusters) — labeled as hypothesis.',
      '4. Table or bar chart. Numbers must come from the query.',
    ].join('\n'),
  },
  {
    id: 'school-cluster',
    category: 'recommended',
    title_zh: '学校聚集性提示',
    title_en: 'School-cluster briefing',
    description_zh: '按学校聚集性疫情口径整理病例时间、班级和已采取的措施清单。',
    description_en: 'Brief a school cluster: timeline, classes involved, and actions already taken.',
    body_zh: [
      '# 学校聚集性提示',
      '',
      '## When to use',
      '用户提到学校、幼儿园、班级聚集、缺勤异常或校园疫情处置。',
      '',
      '## How to do it',
      '1. 先核对时间、学校、班级、症状或病种，缺一项就问清楚再查。',
      '2. 按发病或报告时间排列病例，标出同一班级或同一宿舍。',
      '3. 列出已采取和待落实的措施（隔离、消毒、停课建议须符合当地方案，不要自行发明标准）。',
      '4. 输出给疾控同事看的短报：背景、现状、风险、建议。涉及个人身份时只保留必要字段。',
    ].join('\n'),
    body_en: [
      '# School-cluster briefing',
      '',
      '## When to use',
      'The user mentions a school or kindergarten cluster, unusual absence, or campus response.',
      '',
      '## How to do it',
      '1. Confirm dates, school, class, and syndrome/disease. Ask before querying if any is missing.',
      '2. Timeline cases. Flag the same class or dorm.',
      '3. List actions taken vs still needed. Isolation, disinfection, and closure advice must follow local protocol — do not invent thresholds.',
      '4. Short note: background, now, risk, next steps. Keep identifiers to the minimum needed.',
    ].join('\n'),
  },
];

export function resolvePlazaSkill(skill: PlazaSkill, locale: Locale): PlazaSkillView {
  const zh = locale !== 'en';
  return {
    id: skill.id,
    category: skill.category,
    title: zh ? skill.title_zh : skill.title_en,
    description: zh ? skill.description_zh : skill.description_en,
    body: zh ? skill.body_zh : skill.body_en,
  };
}

export function resolvePlazaSkills(locale: Locale, category?: PlazaCategory): PlazaSkillView[] {
  return PLAZA_SKILLS.filter((skill) => !category || skill.category === category).map((skill) =>
    resolvePlazaSkill(skill, locale),
  );
}

export function filterPlazaSkills(skills: PlazaSkillView[], query: string): PlazaSkillView[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((skill) => {
    const hay = [skill.id, skill.title, skill.description].join('\n').toLowerCase();
    return hay.includes(q);
  });
}

export function installedSkillNames(skills: { name: string }[]): Set<string> {
  return new Set(skills.map((skill) => skill.name));
}

export function isPlazaInstalled(id: string, installed: Set<string>): boolean {
  return installed.has(id);
}
