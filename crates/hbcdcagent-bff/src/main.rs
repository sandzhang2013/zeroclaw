//! Login and reverse-proxy BFF in front of ZeroClaw for 数智疾控.
//!
//! Separate process: user-center secrets never enter `zeroclaw daemon`.
//! Workspace clippy forbids `tracing::*` / `anyhow::anyhow` in daemon crates;
//! this binary is intentionally outside that log contract.
#![allow(clippy::disallowed_macros, clippy::disallowed_methods)]

mod config;
mod crypto;
mod error_page;
mod identity;
mod proxy;
mod session;
mod user_center;

use crate::config::Config;
use crate::error_page::{LoginErrorKind, login_error_response};
use crate::identity::{
    Identity, clear_mock_cookie_header, map_role, mock_user, mock_user_cookie_header,
    normalize_user_id,
};
use crate::proxy::{AppState, fallback};
use crate::session::{
    SessionStore, append_set_cookie, clear_cookie_header, clear_state_cookie_header, cookie_header,
    sid_from_cookie_header, sso_state_matches,
};
use crate::user_center::{LoginFetchError, UserCenter};
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
    state: Option<String>,
}

#[derive(Deserialize)]
struct MockLoginQuery {
    user: Option<String>,
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
        .route(Config::HEALTH_PATH, get(health))
        .route(Config::CALLBACK_PATH, get(callback))
        .route(Config::MOCK_PATH, get(mock_login))
        .route(Config::LOGOUT_PATH, get(logout).post(logout))
        .fallback(fallback)
        .with_state(state))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> &'static str {
    "ok"
}

async fn mock_login(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MockLoginQuery>,
) -> Response {
    if !state.cfg.local_mock {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let Some(user_id) = query
        .user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, "missing user").into_response();
    };
    if mock_user(user_id).is_none() {
        return (StatusCode::BAD_REQUEST, "unknown mock user").into_response();
    }
    let mut response = Redirect::temporary(Config::workbench_path()).into_response();
    match mock_user_cookie_header(user_id).parse() {
        Ok(value) => {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "cookie").into_response();
        }
    }
    response
}

async fn callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(code) = query
        .verify_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return login_error_response(
            StatusCode::BAD_REQUEST,
            &state.cfg,
            LoginErrorKind::MissingVerifyCode,
        );
    };
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    if !sso_state_matches(cookie, query.state.as_deref()) {
        return login_error_response(
            StatusCode::BAD_REQUEST,
            &state.cfg,
            LoginErrorKind::InvalidState,
        );
    }
    let info = match state.user_center.user_info_by_verify_code(code).await {
        Ok(info) => info,
        Err(LoginFetchError::UserInfo(err)) => {
            tracing::warn!(error = %err, "verifyCode exchange failed");
            return login_error_response(
                StatusCode::BAD_GATEWAY,
                &state.cfg,
                LoginErrorKind::ExchangeFailed,
            );
        }
        Err(LoginFetchError::TenantDetail(err)) => {
            tracing::warn!(error = %err, "tenant detail failed");
            return login_error_response(
                StatusCode::BAD_GATEWAY,
                &state.cfg,
                LoginErrorKind::TenantDetailFailed,
            );
        }
    };
    let user_id = match normalize_user_id(&info.user_id) {
        Ok(id) => id,
        Err(_) => {
            return login_error_response(
                StatusCode::BAD_REQUEST,
                &state.cfg,
                LoginErrorKind::InvalidUserId,
            );
        }
    };
    let identity = Identity {
        display_name: info.display_name,
        role: map_role(&user_id, &state.cfg.ops_user_ids),
        region: info.city_code,
        org: info.tenant_name,
        user_id,
    };
    let sid = state.sessions.insert(identity, state.cfg.session_ttl);
    let cookie = cookie_header(&sid, state.cfg.session_ttl, state.cfg.cookie_secure);
    let mut response = Redirect::temporary(Config::workbench_path()).into_response();
    append_set_cookie(&mut response, &cookie);
    append_set_cookie(
        &mut response,
        &clear_state_cookie_header(state.cfg.cookie_secure),
    );
    response
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(sid) =
        sid_from_cookie_header(headers.get(header::COOKIE).and_then(|v| v.to_str().ok()))
    {
        state.sessions.remove(&sid);
    }
    let secure = state.cfg.cookie_secure;
    let bounce = state.cfg.logout_url.is_some() || state.cfg.local_mock;
    let mut response = if let Some(url) = state.cfg.logout_url.as_deref() {
        Redirect::temporary(url).into_response()
    } else if state.cfg.local_mock {
        Redirect::temporary(Config::workbench_path()).into_response()
    } else {
        login_error_response(StatusCode::OK, &state.cfg, LoginErrorKind::LoggedOut)
    };
    append_set_cookie(&mut response, &clear_cookie_header(secure));
    append_set_cookie(&mut response, &clear_mock_cookie_header(secure));
    if bounce {
        append_set_cookie(&mut response, &clear_state_cookie_header(secure));
    }
    response
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)]
mod http_tests;
