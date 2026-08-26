//! Login and reverse-proxy BFF in front of ZeroClaw for 数智疾控.
//!
//! Separate process: user-center secrets never enter `zeroclaw daemon`.
//! Workspace clippy forbids `tracing::*` / `anyhow::anyhow` in daemon crates;
//! this binary is intentionally outside that log contract.
#![allow(clippy::disallowed_macros)]

mod config;
mod crypto;
mod identity;
mod proxy;
mod session;
mod user_center;

use crate::config::Config;
use crate::identity::{Identity, map_role, normalize_user_id};
use crate::proxy::{AppState, fallback};
use crate::session::{SessionStore, clear_cookie_header, cookie_header, sid_from_cookie_header};
use crate::user_center::UserCenter;
use anyhow::Context;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use serde::Deserialize;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Deserialize)]
struct CallbackQuery {
    #[serde(rename = "verifyCode")]
    verify_code: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cfg = Config::from_env()?;
    let listen = cfg.listen;
    tracing::info!(%listen, upstream = %cfg.upstream, "hbcdcagent-bff starting");
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("bind {listen}"))?;
    axum::serve(listener, router(cfg)?)
        .with_graceful_shutdown(shutdown())
        .await
        .context("server")?;
    Ok(())
}

pub(crate) fn router(cfg: Config) -> anyhow::Result<Router> {
    let sessions = Arc::new(SessionStore::default());
    let state = Arc::new(AppState {
        sessions: sessions.clone(),
        user_center: Arc::new(UserCenter::new(cfg.clone())?),
        http: crate::proxy::http_client(),
        cfg,
    });
    Ok(Router::new()
        .route("/health", get(health))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", get(logout).post(logout))
        .fallback(fallback)
        .with_state(state))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> &'static str {
    "ok"
}

async fn callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(code) = query
        .verify_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, "missing verifyCode").into_response();
    };
    let info = match state.user_center.user_info_by_verify_code(code).await {
        Ok(info) => info,
        Err(err) => {
            tracing::warn!(error = %err, "verifyCode exchange failed");
            return (StatusCode::BAD_GATEWAY, "login failed").into_response();
        }
    };
    let user_id = match normalize_user_id(&info.user_id) {
        Ok(id) => id,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid userId").into_response(),
    };
    let identity = Identity {
        role: map_role(&user_id, &state.cfg.ops_user_ids),
        region: None,
        org: info.tenant_name,
        user_id,
    };
    let sid = state.sessions.insert(identity, state.cfg.session_ttl);
    let cookie = cookie_header(&sid, state.cfg.session_ttl, state.cfg.cookie_secure);
    let mut response = Redirect::temporary(Config::workbench_path()).into_response();
    match cookie.parse() {
        Ok(value) => {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "cookie").into_response();
        }
    }
    response
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(sid) =
        sid_from_cookie_header(headers.get(header::COOKIE).and_then(|v| v.to_str().ok()))
    {
        state.sessions.remove(&sid);
    }
    let mut response = Redirect::temporary("/").into_response();
    if let Ok(value) = clear_cookie_header(state.cfg.cookie_secure).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)]
mod http_tests;
