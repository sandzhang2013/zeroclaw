//! Workbench home starter catalog (`[workbench.home]`).
//!
//! Canonical source for the workbench homepage tabs and capability chips.
//! Operators edit the list through the dashboard Config explorer (ops-only
//! `/api/config`). The homepage reads a resolved view via
//! `GET /api/workbench/home`. An empty list resolves to the built-in catalog
//! so a wiped section cannot blank the home screen.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use zeroclaw_macros::Configurable;

use crate::validation_bail;

/// Allowed Lucide icon ids for homepage chips. Unknown values still save
/// but resolve to `file-text` on the read path.
pub const HOME_CAP_ICONS: &[&str] = &[
    "activity",
    "syringe",
    "search",
    "building-2",
    "bar-chart-3",
    "shield-alert",
    "map",
    "file-text",
    "clipboard-list",
];

const MAX_PROMPT_CHARS: usize = 4000;
const DEFAULT_ICON: &str = "file-text";
const DEFAULT_KIND: &str = "chat";

/// `[workbench]` root.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Configurable)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
#[prefix = "workbench"]
pub struct WorkbenchConfig {
    /// Homepage starter catalog.
    #[serde(default)]
    #[nested]
    pub home: WorkbenchHomeConfig,
}

/// `[workbench.home]` — flattened capability list grouped by `tab` at read time.
#[derive(Debug, Clone, Serialize, Deserialize, Configurable)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
#[prefix = "workbench.home"]
pub struct WorkbenchHomeConfig {
    /// Starter chips. `id` is the dashboard alias (`+ Add` / rename).
    /// Empty means “use the built-in catalog” on the homepage read path.
    #[serde(default = "builtin_home_caps")]
    #[nested]
    #[natural_key = "id"]
    pub caps: Vec<WorkbenchHomeCap>,
}

impl Default for WorkbenchHomeConfig {
    fn default() -> Self {
        Self {
            caps: builtin_home_caps(),
        }
    }
}

/// One homepage chip. `tab` groups chips into the query / monitor / report row.
#[derive(Debug, Clone, Serialize, Deserialize, Default, Configurable)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
#[prefix = "workbench.home.caps"]
pub struct WorkbenchHomeCap {
    /// Stable id and Config map key.
    #[serde(default)]
    pub id: String,
    /// Tab group (`query`, `monitor`, `report`, or a custom id).
    #[serde(default)]
    pub tab: String,
    /// Optional Chinese tab label. First non-empty value per `tab` wins.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tab_label_zh: String,
    /// Optional English tab label. First non-empty value per `tab` wins.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tab_label_en: String,
    /// Lucide icon id (see `HOME_CAP_ICONS`).
    #[serde(default)]
    pub icon: String,
    /// `chat` fills the composer; `outline` is the same send path but marked
    /// for outline-edit detection (prompts typically contain 提纲).
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Chinese chip label.
    #[serde(default)]
    pub label_zh: String,
    /// English chip label. Falls back to `label_zh` when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label_en: String,
    /// Chinese prompt inserted into the composer.
    #[serde(default)]
    pub prompt_zh: String,
    /// English prompt. Falls back to `prompt_zh` when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt_en: String,
}

fn default_kind() -> String {
    DEFAULT_KIND.to_string()
}

/// Built-in catalog matching the previous hardcoded workbench home chips.
#[must_use]
pub fn builtin_home_caps() -> Vec<WorkbenchHomeCap> {
    vec![
        cap(
            "outbreak",
            "query",
            "数据查询",
            "Query",
            "activity",
            "chat",
            "疫情概况",
            "Outbreak overview",
            "帮我查询并概述近期全省传染病疫情情况。",
            "Query and summarize recent infectious-disease conditions across the province.",
        ),
        cap(
            "vaccine",
            "query",
            "数据查询",
            "Query",
            "syringe",
            "chat",
            "疫苗覆盖",
            "Vaccination coverage",
            "帮我查询并解读近期疫苗接种覆盖率。",
            "Look up and explain recent vaccination coverage.",
        ),
        cap(
            "cases",
            "query",
            "数据查询",
            "Query",
            "search",
            "chat",
            "病例检索",
            "Case search",
            "帮我按地区和时间检索病例数据并给出要点。",
            "Search cases by region and time, then highlight the key points.",
        ),
        cap(
            "orgs",
            "query",
            "数据查询",
            "Query",
            "building-2",
            "chat",
            "机构名单",
            "Facility list",
            "帮我查询相关疾控与医疗机构名单并整理成表。",
            "Look up CDC and medical facilities and organize them into a table.",
        ),
        cap(
            "trend",
            "monitor",
            "监测分析",
            "Surveillance",
            "bar-chart-3",
            "chat",
            "趋势分析",
            "Trend analysis",
            "根据监测数据帮我分析近期疫情趋势并解读关键变化。",
            "Analyze recent epidemic trends from surveillance data and explain key changes.",
        ),
        cap(
            "cluster",
            "monitor",
            "监测分析",
            "Surveillance",
            "shield-alert",
            "chat",
            "聚集性疫情",
            "Cluster events",
            "帮我梳理近期聚集性疫情情况并提示风险点。",
            "Summarize recent cluster outbreaks and flag risk points.",
        ),
        cap(
            "alert",
            "monitor",
            "监测分析",
            "Surveillance",
            "activity",
            "chat",
            "预警信号",
            "Alert signals",
            "帮我分析近期预警信号数据并给出研判建议。",
            "Analyze recent alert signals and provide an assessment.",
        ),
        cap(
            "region",
            "monitor",
            "监测分析",
            "Surveillance",
            "map",
            "chat",
            "地区对比",
            "Regional compare",
            "帮我对比各地市监测指标差异并标出异常地区。",
            "Compare prefecture-level indicators and mark unusual areas.",
        ),
        cap(
            "brief",
            "report",
            "报告撰写",
            "Reports",
            "file-text",
            "outline",
            "工作简报",
            "Work brief",
            "帮我起草一份疾控工作简报提纲，结构清晰、重点突出。",
            "Draft a CDC work-brief outline with a clear structure and key points.",
        ),
        cap(
            "weekly",
            "report",
            "报告撰写",
            "Reports",
            "clipboard-list",
            "outline",
            "监测周报",
            "Weekly report",
            "帮我起草本周传染病监测周报提纲。",
            "Draft an outline for this week’s infectious-disease surveillance report.",
        ),
        cap(
            "special",
            "report",
            "报告撰写",
            "Reports",
            "file-text",
            "outline",
            "专题报告",
            "Special report",
            "帮我起草一份专题分析报告提纲，含背景、发现和建议。",
            "Draft a special-analysis report outline covering background, findings, and recommendations.",
        ),
        cap(
            "minutes",
            "report",
            "报告撰写",
            "Reports",
            "clipboard-list",
            "outline",
            "会议纪要",
            "Meeting notes",
            "帮我按疾控例会口径整理一份会议纪要提纲。",
            "Draft a meeting-minutes outline in CDC standing-meeting style.",
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn cap(
    id: &str,
    tab: &str,
    tab_zh: &str,
    tab_en: &str,
    icon: &str,
    kind: &str,
    label_zh: &str,
    label_en: &str,
    prompt_zh: &str,
    prompt_en: &str,
) -> WorkbenchHomeCap {
    WorkbenchHomeCap {
        id: id.to_string(),
        tab: tab.to_string(),
        tab_label_zh: tab_zh.to_string(),
        tab_label_en: tab_en.to_string(),
        icon: icon.to_string(),
        kind: kind.to_string(),
        label_zh: label_zh.to_string(),
        label_en: label_en.to_string(),
        prompt_zh: prompt_zh.to_string(),
        prompt_en: prompt_en.to_string(),
    }
}

/// Resolved homepage payload served to any authenticated workbench user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
pub struct WorkbenchHomeCatalog {
    /// `config` when at least one cap is stored; `builtin` when the list is empty.
    pub source: String,
    pub tabs: Vec<WorkbenchHomeTabView>,
}

/// One tab in the resolved catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
pub struct WorkbenchHomeTabView {
    pub id: String,
    pub label: String,
    pub caps: Vec<WorkbenchHomeCapView>,
}

/// One chip in the resolved catalog (locale already selected).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
pub struct WorkbenchHomeCapView {
    pub id: String,
    pub icon: String,
    pub kind: String,
    pub label: String,
    pub prompt: String,
}

/// Pick stored caps, or the built-in list when none are configured.
#[must_use]
pub fn caps_or_builtin(caps: &[WorkbenchHomeCap]) -> (&[WorkbenchHomeCap], &'static str) {
    if caps.is_empty() {
        (builtin_home_caps_slice(), "builtin")
    } else {
        (caps, "config")
    }
}

fn builtin_home_caps_slice() -> &'static [WorkbenchHomeCap] {
    use std::sync::OnceLock;
    static BUILTIN: OnceLock<Vec<WorkbenchHomeCap>> = OnceLock::new();
    BUILTIN.get_or_init(builtin_home_caps)
}

/// Group and localize caps for the homepage.
#[must_use]
pub fn resolve_home_catalog(caps: &[WorkbenchHomeCap], locale: &str) -> WorkbenchHomeCatalog {
    let (caps, source) = caps_or_builtin(caps);
    let zh = locale_is_zh(locale);
    let mut tabs: Vec<WorkbenchHomeTabView> = Vec::new();
    for cap in caps {
        let tab_id = cap.tab.trim();
        if tab_id.is_empty() || cap.id.trim().is_empty() {
            continue;
        }
        let label = pick_locale(zh, &cap.label_zh, &cap.label_en);
        let prompt = pick_locale(zh, &cap.prompt_zh, &cap.prompt_en);
        if label.is_empty() && prompt.is_empty() {
            continue;
        }
        let icon = if HOME_CAP_ICONS.contains(&cap.icon.as_str()) {
            cap.icon.clone()
        } else {
            DEFAULT_ICON.to_string()
        };
        let kind = if cap.kind.trim() == "outline" {
            "outline"
        } else {
            DEFAULT_KIND
        };
        let view = WorkbenchHomeCapView {
            id: cap.id.trim().to_string(),
            icon,
            kind: kind.to_string(),
            label,
            prompt,
        };
        if let Some(tab) = tabs.iter_mut().find(|t| t.id == tab_id) {
            tab.caps.push(view);
        } else {
            let tab_label = pick_locale(zh, &cap.tab_label_zh, &cap.tab_label_en);
            tabs.push(WorkbenchHomeTabView {
                id: tab_id.to_string(),
                label: if tab_label.is_empty() {
                    tab_id.to_string()
                } else {
                    tab_label
                },
                caps: vec![view],
            });
        }
    }
    WorkbenchHomeCatalog {
        source: source.to_string(),
        tabs,
    }
}

fn locale_is_zh(locale: &str) -> bool {
    locale.trim().eq_ignore_ascii_case("zh") || locale.to_ascii_lowercase().starts_with("zh-")
}

fn pick_locale(zh: bool, zh_text: &str, en_text: &str) -> String {
    let zh_text = zh_text.trim();
    let en_text = en_text.trim();
    if zh {
        if !zh_text.is_empty() {
            zh_text.to_string()
        } else {
            en_text.to_string()
        }
    } else if !en_text.is_empty() {
        en_text.to_string()
    } else {
        zh_text.to_string()
    }
}

/// Hard checks for dashboard saves. Unknown icons are allowed (resolved later).
pub fn validate_home_caps(caps: &[WorkbenchHomeCap]) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    for (i, cap) in caps.iter().enumerate() {
        let path = format!("workbench.home.caps[{i}]");
        let id = cap.id.trim();
        if id.is_empty() {
            validation_bail!(
                RequiredFieldEmpty,
                format!("{path}.id"),
                "{path}.id must not be empty"
            );
        }
        if !seen.insert(id.to_string()) {
            anyhow::bail!("workbench.home.caps id `{id}` is duplicated");
        }
        if cap.tab.trim().is_empty() {
            validation_bail!(
                RequiredFieldEmpty,
                format!("{path}.tab"),
                "{path}.tab must not be empty"
            );
        }
        let kind = cap.kind.trim();
        if !kind.is_empty() && kind != "chat" && kind != "outline" {
            anyhow::bail!("{path}.kind must be `chat` or `outline`, got `{kind}`");
        }
        if cap.prompt_zh.len() > MAX_PROMPT_CHARS || cap.prompt_en.len() > MAX_PROMPT_CHARS {
            anyhow::bail!("{path} prompt exceeds {MAX_PROMPT_CHARS} characters");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_caps_resolve_to_builtin_three_tabs() {
        let catalog = resolve_home_catalog(&[], "zh");
        assert_eq!(catalog.source, "builtin");
        assert_eq!(
            catalog
                .tabs
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["query", "monitor", "report"]
        );
        assert_eq!(catalog.tabs[0].label, "数据查询");
        assert_eq!(catalog.tabs[0].caps[0].label, "疫情概况");
        assert!(catalog.tabs[2].caps.iter().all(|c| c.kind == "outline"));
    }

    #[test]
    fn english_locale_uses_en_labels() {
        let catalog = resolve_home_catalog(&builtin_home_caps(), "en");
        assert_eq!(catalog.source, "config");
        assert_eq!(catalog.tabs[0].label, "Query");
        assert_eq!(catalog.tabs[0].caps[0].label, "Outbreak overview");
    }

    #[test]
    fn custom_caps_replace_builtin() {
        let caps = vec![WorkbenchHomeCap {
            id: "only".into(),
            tab: "query".into(),
            tab_label_zh: "自定义".into(),
            icon: "nope".into(),
            kind: "chat".into(),
            label_zh: "仅此".into(),
            prompt_zh: "说你好".into(),
            ..Default::default()
        }];
        let catalog = resolve_home_catalog(&caps, "zh");
        assert_eq!(catalog.source, "config");
        assert_eq!(catalog.tabs.len(), 1);
        assert_eq!(catalog.tabs[0].caps.len(), 1);
        assert_eq!(catalog.tabs[0].caps[0].icon, DEFAULT_ICON);
        assert_eq!(catalog.tabs[0].label, "自定义");
    }

    #[test]
    fn duplicate_ids_fail_validate() {
        let cap = WorkbenchHomeCap {
            id: "dup".into(),
            tab: "query".into(),
            ..Default::default()
        };
        let err = validate_home_caps(&[cap.clone(), cap]).unwrap_err();
        assert!(err.to_string().contains("duplicated"));
    }
}
