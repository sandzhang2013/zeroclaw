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
  {
    id: 'syndrome-respiratory',
    category: 'recommended',
    title_zh: '呼吸道症候群监测',
    title_en: 'Respiratory syndrome surveillance',
    description_zh: '结合法定传染病报告和 ILI/SARI，解读流感、新冠、肺炎等呼吸道传染病趋势与风险。',
    description_en: 'Read respiratory diseases with case reports plus ILI/SARI: influenza, COVID-19, pneumonia trends and risk.',
    body_zh: [
      '# 呼吸道症候群监测',
      '',
      '## When to use',
      '用户问呼吸道传染病、流感、新冠、肺炎、ILI、SARI，或要看近期呼吸道流行强度。',
      '',
      '## How to do it',
      '1. 先取监测数据：法定传染病报告（流感、新冠、肺炎相关病种）以及门急诊 ILI%、SARI。缺一项就说明缺什么，不要编数字。',
      '2. 用近 4–8 周说明趋势：上升、平台还是回落；点明优势病原或型别（以监测结果为准）。',
      '3. 标出升幅较大或连续上升的地区，区分输入与本地、聚集与散发。',
      '4. 结尾三句话：总体、需关注点、建议下一步查什么。',
    ].join('\n'),
    body_en: [
      '# Respiratory syndrome surveillance',
      '',
      '## When to use',
      'The user asks about respiratory diseases, influenza, COVID-19, pneumonia, ILI, SARI, or recent respiratory intensity.',
      '',
      '## How to do it',
      '1. Query notifiable reports (flu, COVID-19, pneumonia) plus outpatient ILI% and SARI. Name missing series; do not invent numbers.',
      '2. Cover 4–8 weeks: rising, plateau, or falling. Name dominant pathogens/types from surveillance only.',
      '3. Flag prefectures with large or consecutive rises. Distinguish import vs local, cluster vs sporadic.',
      '4. Close with three sentences: overall, watchpoints, next query.',
    ].join('\n'),
  },
  {
    id: 'syndrome-enteric',
    category: 'recommended',
    title_zh: '肠道症候群监测',
    title_en: 'Enteric syndrome surveillance',
    description_zh: '分析霍乱、痢疾、伤寒、手足口、其他感染性腹泻等肠道传染病报告与聚集线索。',
    description_en: 'Analyze enteric reports (cholera, dysentery, typhoid, HFMD, other infectious diarrhea) and cluster clues.',
    body_zh: [
      '# 肠道症候群监测',
      '',
      '## When to use',
      '用户问肠道传染病、腹泻、霍乱、痢疾、伤寒、手足口、其他感染性腹泻或肠道聚集。',
      '',
      '## How to do it',
      '1. 先取相应病种的报告发病数，默认用户地区；未点名城市时用全省。',
      '2. 对比上一同等窗口，标出升幅大或连续上升的病种和地区。',
      '3. 对异常升高补一句可能原因（季节性、食源、托幼机构、报告延迟），标成推测。',
      '4. 用表列出病种、本期、上期、变化；不要编造未查出的数字。',
    ].join('\n'),
    body_en: [
      '# Enteric syndrome surveillance',
      '',
      '## When to use',
      'The user asks about enteric diseases, diarrhea, cholera, dysentery, typhoid, HFMD, or enteric clusters.',
      '',
      '## How to do it',
      '1. Query the matching notifiable series. Default to the signed-in region; ops without a city use the province.',
      '2. Compare the previous equal window. Flag large or consecutive rises by disease and area.',
      '3. One cautious sentence on possible reasons (season, foodborne, childcare, reporting lag), labeled as hypothesis.',
      '4. Table: disease, this period, last period, change. Do not invent numbers.',
    ].join('\n'),
  },
  {
    id: 'syndrome-vector',
    category: 'recommended',
    title_zh: '虫媒症候群监测',
    title_en: 'Vector-borne syndrome surveillance',
    description_zh: '结合登革热、基孔肯雅热、疟疾报告和布雷图指数等媒介指标，提示输入与本地传播风险。',
    description_en: 'Read dengue, chikungunya, malaria plus vector indices such as the Breteau index; flag import vs local risk.',
    body_zh: [
      '# 虫媒症候群监测',
      '',
      '## When to use',
      '用户问登革热、基孔肯雅热、疟疾、蚊媒、布雷图指数，或输入病例是否可能本地传播。',
      '',
      '## How to do it',
      '1. 先取病例报告（发病/报告时间、地区）和可获得的媒介指标（如布雷图指数）。',
      '2. 区分输入与本地；本地病例要标出时间和地点是否重叠。',
      '3. 媒介指标升高但尚无本地病例时，明确写成风险提示而非已发生疫情。',
      '4. 建议下一步只写监测口径内能核实的动作。数据缺失时直接说明。',
    ].join('\n'),
    body_en: [
      '# Vector-borne syndrome surveillance',
      '',
      '## When to use',
      'The user asks about dengue, chikungunya, malaria, mosquito vectors, the Breteau index, or import vs local transmission.',
      '',
      '## How to do it',
      '1. Query case reports (onset/report date, area) and available vector indices (e.g. Breteau).',
      '2. Separate imported from local. For local cases, say whether time and place overlap.',
      '3. High vector indices without local cases are a risk note, not an outbreak claim.',
      '4. Next steps must be verifiable in surveillance. Say which series is missing.',
    ].join('\n'),
  },
  {
    id: 'syndrome-covid',
    category: 'recommended',
    title_zh: '新冠监测解读',
    title_en: 'COVID-19 surveillance reading',
    description_zh: '解读近期新冠报告发病与新冠病原监测变化，说明流行强度。',
    description_en: 'Interpret recent COVID-19 case reports and pathogen monitoring, and state intensity.',
    body_zh: [
      '# 新冠监测解读',
      '',
      '## When to use',
      '用户问新冠、COVID-19、新冠病原、阳性率或近期新冠流行强度。',
      '',
      '## How to do it',
      '1. 同时看新冠报告发病和新冠病原监测，不要只报一个指标。',
      '2. 用近 4–8 周说明趋势：上升、平台还是回落。',
      '3. 地区默认登录用户所在地；不要把外地数据说成本地。',
      '4. 数据缺失时直接说明缺哪一项；不要推断未监测到的变异株或住院负担。',
    ].join('\n'),
    body_en: [
      '# COVID-19 surveillance reading',
      '',
      '## When to use',
      'The user asks about COVID-19 cases, pathogen positivity, or recent intensity.',
      '',
      '## How to do it',
      '1. Use case reports and pathogen monitoring together. Never report only one.',
      '2. Cover 4–8 weeks: rising, plateau, or falling.',
      '3. Default to the signed-in region. Do not present another area as local.',
      '4. Name missing series. Do not infer unmonitored variants or hospital burden.',
    ].join('\n'),
  },
  {
    id: 'syndrome-pneumonia',
    category: 'recommended',
    title_zh: '肺炎与SARI监测',
    title_en: 'Pneumonia and SARI surveillance',
    description_zh: '分析肺炎相关报告与 SARI 监测，标出异常升高地区并提示重症风险。',
    description_en: 'Analyze pneumonia reports and SARI, mark unusual rises, and flag severe-disease risk.',
    body_zh: [
      '# 肺炎与SARI监测',
      '',
      '## When to use',
      '用户问肺炎、重症急性呼吸道感染（SARI）、住院呼吸道重症或肺炎是否异常升高。',
      '',
      '## How to do it',
      '1. 先取肺炎相关报告和 SARI 监测；能配流感/新冠病原时一并看。',
      '2. 对比近期窗口，标出异常升高的地区，并说明是报告还是 SARI 在升。',
      '3. 重症风险只根据监测口径写，不要把门诊 ILI 直接说成重症。',
      '4. 结尾：总体、异常地区、建议复核的指标。数字必须来自查询。',
    ].join('\n'),
    body_en: [
      '# Pneumonia and SARI surveillance',
      '',
      '## When to use',
      'The user asks about pneumonia, SARI, severe respiratory admissions, or unusual pneumonia rises.',
      '',
      '## How to do it',
      '1. Query pneumonia-related reports and SARI; add flu/COVID pathogen series when available.',
      '2. Compare recent windows. Flag prefectures and say whether reports or SARI are rising.',
      '3. Severe-disease comments stay within surveillance. Do not treat outpatient ILI as severity.',
      '4. Close with overall, unusual areas, and which indicators to re-check. Numbers from queries only.',
    ].join('\n'),
  },
  {
    id: 'syndrome-five-id',
    category: 'recommended',
    title_zh: '五大症候群识别',
    title_en: 'Five-syndrome identification',
    description_zh: '按发热呼吸道、腹泻、脑炎脑膜炎、发热伴出疹、发热伴出血口径做症候群识别，并给出排查建议。',
    description_en: 'Classify febrile respiratory, diarrhea, encephalitis/meningitis, febrile rash, or febrile hemorrhage, and suggest next checks.',
    body_zh: [
      '# 五大症候群识别',
      '',
      '## When to use',
      '用户给出症状、体征或病例描述，要判断属于哪一类监测症候群，或问五大症候群怎么分。',
      '',
      '## How to do it',
      '1. 只在这五类中选择：发热呼吸道、腹泻、脑炎脑膜炎、发热伴出疹、发热伴出血。依据不足时列出候选并说明缺哪些信息。',
      '2. 写清识别依据（主要症状、体征、病程），不要用未提供的检验结果去坐实诊断。',
      '3. 下一步排查建议对准监测口径（需补的症状、标本、接触史、聚集线索），不要写成临床确诊路径。',
      '4. 若用户同时给了地区和时间，可再查对应监测数据作旁证，但仍把分类与数据分开写。',
    ].join('\n'),
    body_en: [
      '# Five-syndrome identification',
      '',
      '## When to use',
      'The user describes symptoms or a case and wants a syndromic class, or asks how the five syndromes are split.',
      '',
      '## How to do it',
      '1. Choose only among: febrile respiratory, diarrhea, encephalitis/meningitis, febrile rash, febrile hemorrhage. If evidence is thin, list candidates and missing facts.',
      '2. State criteria from given symptoms/signs/course. Do not invent lab results.',
      '3. Next checks follow surveillance (missing symptoms, specimens, exposure, clusters), not a clinical diagnosis pathway.',
      '4. If area and dates are given, optional supporting queries stay separate from the classification.',
    ].join('\n'),
  },
  {
    id: 'syndrome-ili-alert',
    category: 'recommended',
    title_zh: 'ILI识别和预警',
    title_en: 'ILI identification and alert',
    description_zh: '用门诊 ILI%、SARI 和流感病原构成判断是否触发预警，并给出分级建议。',
    description_en: 'Use outpatient ILI%, SARI, and flu pathogen mix to decide whether an alert triggers and at what level.',
    body_zh: [
      '# ILI识别和预警',
      '',
      '## When to use',
      '用户问流感样病例识别、ILI 是否超警戒、要不要预警，或门急诊 ILI% 结合病原该如何研判。',
      '',
      '## How to do it',
      '1. 先取门诊 ILI%、SARI 和流感病原构成，三者一起看。',
      '2. 按当地已有预警口径判断是否触发；口径未提供时只描述是否明显高于近几周或往年同期，不要自造阈值。',
      '3. 分级建议写成监测研判（关注/预警/强化监测），并标明依据是哪一项指标。',
      '4. 数据缺失或周次不齐时明确说不能判定，而不是用估计值凑预警。',
    ].join('\n'),
    body_en: [
      '# ILI identification and alert',
      '',
      '## When to use',
      'The user asks how to recognize ILI, whether ILI is above alert, or how to read ILI% with pathogen mix.',
      '',
      '## How to do it',
      '1. Query outpatient ILI%, SARI, and flu pathogen mix together.',
      '2. Apply the local alert rule when known. If none is given, only say whether the series is above recent weeks or the same period last year — do not invent thresholds.',
      '3. Recommend a surveillance level (watch / alert / intensify) and name which indicator supports it.',
      '4. If a series or week is missing, say the alert cannot be judged. Do not fill gaps with estimates.',
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
