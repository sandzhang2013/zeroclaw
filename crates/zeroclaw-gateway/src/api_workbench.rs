//! Workbench homepage catalog.
//!
//! `GET /api/workbench/home` — any authenticated workbench user, locale-resolved.
//! `GET`/`PUT /api/workbench/home/catalog` — ops nested editor (both locales).
//! Canonical storage remains `workbench.home.caps`.

use std::sync::Arc;

use axum::extract::{Json, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use zeroclaw_config::workbench::{
    HomeTabEdit, caps_to_edit_catalog, edit_catalog_to_caps, resolve_home_catalog,
};

use super::AppState;
use super::api_config::persist_and_swap;

#[derive(Debug, Deserialize)]
pub struct HomeQuery {
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HomeCatalogPut {
    #[serde(default)]
    pub tabs: Vec<HomeTabEdit>,
}

/// GET /api/workbench/home — resolved homepage tabs for the current locale.
pub async fn handle_workbench_home(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HomeQuery>,
) -> impl IntoResponse {
    if let Err(e) = crate::trusted_proxy::require_user_principal(&state, &headers) {
        return e.into_response();
    }

    let config = state.config.read();
    let locale = query
        .locale
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            config
                .locale
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "zh".to_string());
    let catalog = resolve_home_catalog(&config.workbench.home.caps, &locale);
    (StatusCode::OK, axum::Json(catalog)).into_response()
}

/// GET /api/workbench/home/catalog — nested bilingual catalog for the ops editor.
pub async fn handle_workbench_home_catalog_get(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(e) = crate::trusted_proxy::require_ops_auth(&state, &headers) {
        return e.into_response();
    }
    let caps = state.config.read().workbench.home.caps.clone();
    (StatusCode::OK, axum::Json(caps_to_edit_catalog(&caps))).into_response()
}

/// PUT /api/workbench/home/catalog — replace stored caps from the nested editor.
pub async fn handle_workbench_home_catalog_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<HomeCatalogPut>,
) -> impl IntoResponse {
    if let Err(e) = crate::trusted_proxy::require_ops_auth(&state, &headers) {
        return e.into_response();
    }
    let caps = match edit_catalog_to_caps(&body.tabs) {
        Ok(caps) => caps,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let _cfg_guard = Arc::clone(&state.config_write_lock).lock_owned().await;
    let mut working = state.config.read().clone();
    working.workbench.home.caps = caps.clone();
    working.mark_dirty("workbench.home.caps");
    if let Err(e) = persist_and_swap(&state, working, &_cfg_guard).await {
        return super::api_config::error_response(e);
    }
    (StatusCode::OK, axum::Json(caps_to_edit_catalog(&caps))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_state;
    use axum::http::HeaderValue;
    use http_body_util::BodyExt;
    use zeroclaw_config::workbench::WorkbenchHomeCap;
    use zeroclaw_runtime::security::pairing::PairingGuard;

    fn pairing_on_bff_state(tmp: &tempfile::TempDir) -> AppState {
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        let mut state = test_state(config);
        state.pairing = std::sync::Arc::new(PairingGuard::new(true, &[]));
        state
    }

    fn bff_headers(user: &str, role: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        h.insert("x-user-id", HeaderValue::from_str(user).unwrap());
        h.insert(
            "x-user-role",
            HeaderValue::from_bytes(role.as_bytes()).unwrap(),
        );
        h
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn home_accepts_bff_normal_user() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["tabs"][0]["label"], "数据查询");
        assert_eq!(json["tabs"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn home_rejects_missing_identity() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let response = handle_workbench_home(
            State(state),
            HeaderMap::new(),
            Query(HomeQuery { locale: None }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn home_empty_caps_fall_back_to_builtin() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        state.config.write().workbench.home.caps.clear();
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        let json = body_json(response).await;
        assert_eq!(json["source"], "builtin");
        assert_eq!(json["tabs"][0]["caps"][0]["label"], "疫情概况");
        assert_eq!(
            json["tabs"][0]["caps"][0]["prompts"][0]["text"],
            "帮我查询并概述近期全省传染病疫情情况。"
        );
    }

    #[tokio::test]
    async fn home_uses_configured_caps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        state.config.write().workbench.home.caps = vec![WorkbenchHomeCap {
            id: "hello".into(),
            tab: "query".into(),
            tab_label_zh: "问数".into(),
            icon: "search".into(),
            kind: "chat".into(),
            label_zh: "问好".into(),
            prompt_zh: "你好".into(),
            ..Default::default()
        }];
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        let json = body_json(response).await;
        assert_eq!(json["source"], "config");
        assert_eq!(json["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(json["tabs"][0]["label"], "问数");
        assert_eq!(json["tabs"][0]["caps"][0]["prompts"][0]["text"], "你好");
    }

    #[tokio::test]
    async fn catalog_get_is_ops_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let denied = handle_workbench_home_catalog_get(
            State(state.clone()),
            bff_headers("alice", "普通用户"),
        )
        .await
        .into_response();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let ok = handle_workbench_home_catalog_get(State(state), bff_headers("ops", "运维"))
            .await
            .into_response();
        assert_eq!(ok.status(), StatusCode::OK);
        let json = body_json(ok).await;
        assert_eq!(json["tabs"][0]["label_zh"], "数据查询");
        assert_eq!(json["tabs"][0]["caps"][0]["label_zh"], "疫情概况");
    }

    #[tokio::test]
    async fn catalog_put_writes_nested_caps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let body = HomeCatalogPut {
            tabs: vec![zeroclaw_config::workbench::HomeTabEdit {
                id: "query".into(),
                label_zh: "问数".into(),
                label_en: "Ask".into(),
                caps: vec![zeroclaw_config::workbench::HomeCapEdit {
                    id: "hello".into(),
                    icon: "search".into(),
                    kind: "chat".into(),
                    label_zh: "问好".into(),
                    prompts: vec![zeroclaw_config::workbench::HomePromptEdit {
                        id: "hello_p1".into(),
                        text_zh: "你好".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
            }],
        };
        let response = handle_workbench_home_catalog_put(
            State(state.clone()),
            bff_headers("ops", "运维"),
            Json(body),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["source"], "config");
        assert_eq!(json["tabs"][0]["label_zh"], "问数");
        assert_eq!(json["tabs"][0]["caps"][0]["prompts"][0]["text_zh"], "你好");
        assert_eq!(state.config.read().workbench.home.caps[0].id, "hello");
        assert_eq!(
            state.config.read().workbench.home.caps[0].prompts[0].text_zh,
            "你好"
        );
    }

    #[tokio::test]
    async fn catalog_put_empty_resets_to_builtin() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        state.config.write().workbench.home.caps = vec![WorkbenchHomeCap {
            id: "hello".into(),
            tab: "query".into(),
            label_zh: "问好".into(),
            prompt_zh: "你好".into(),
            ..Default::default()
        }];
        let response = handle_workbench_home_catalog_put(
            State(state.clone()),
            bff_headers("ops", "运维"),
            Json(HomeCatalogPut { tabs: vec![] }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state.config.read().workbench.home.caps.is_empty());
        let json = body_json(response).await;
        assert_eq!(json["source"], "builtin");
    }
}
