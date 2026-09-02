//! Self-contained HTML for BFF login failures.
//!
//! These responses must not depend on daemon static assets: SSO mode does not
//! forward the workbench SPA until a session exists.

use crate::config::Config;
use crate::session::{STATE_TTL, append_set_cookie, state_cookie_header};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum LoginErrorKind {
    MissingVerifyCode,
    ExchangeFailed,
    TenantDetailFailed,
    InvalidUserId,
    InvalidState,
    NoLoginEntry,
    LoggedOut,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StepStatus {
    Configured,
    Done,
    Missing,
    Failed,
    Pending,
}

impl StepStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Configured => "已配置",
            Self::Done => "通过",
            Self::Missing => "未配置",
            Self::Failed => "失败",
            Self::Pending => "未执行",
        }
    }

    fn css(self) -> &'static str {
        match self {
            Self::Configured | Self::Done => "ok",
            Self::Missing => "miss",
            Self::Failed => "fail",
            Self::Pending => "wait",
        }
    }
}

struct Step {
    title: &'static str,
    status: StepStatus,
    detail: String,
}

impl LoginErrorKind {
    fn copy(self) -> (&'static str, &'static str) {
        match self {
            Self::MissingVerifyCode => (
                "登录回调无效",
                "用户中心没有把登录凭证带回工作台。对照下面清单：卡住的是回调这一步。",
            ),
            Self::ExchangeFailed => (
                "登录未能完成",
                "用户中心登录已成功，但工作台未能用 verifyCode 换到用户。对照下面清单：卡住的是换用户。",
            ),
            Self::TenantDetailFailed => (
                "登录未能完成",
                "已换到用户，但查询租户区域代码失败。对照下面清单：卡住的是 /console/tenant/detail。",
            ),
            Self::InvalidUserId => (
                "登录身份无效",
                "用户中心已返回账号，但无法用于工作台。对照下面清单：卡住的是进入工作台。",
            ),
            Self::InvalidState => (
                "登录校验失败",
                "回调与发起登录的浏览器不一致（state）。请从工作台重新登录，不要打开别人转发的回调链接。",
            ),
            Self::NoLoginEntry => (
                "无法进入工作台",
                "本地模拟登录已关闭。对照下面清单补齐用户中心配置后，重新打开工作台。",
            ),
            Self::LoggedOut => (
                "已退出登录",
                "工作台会话已清除。若点「重新登录」后又自动进入，需要配置 USER_CENTER_LOGOUT_URL。",
            ),
        }
    }
}

pub fn login_error_response(status: StatusCode, cfg: &Config, kind: LoginErrorKind) -> Response {
    let state = cfg
        .login_redirect()
        .is_some()
        .then(|| Uuid::new_v4().to_string());
    let html = render(cfg, kind, state.as_deref());
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response();
    if let Some(state) = state {
        append_set_cookie(
            &mut response,
            &state_cookie_header(&state, STATE_TTL, cfg.cookie_secure),
        );
    }
    response
}

fn missing_login_env(cfg: &Config) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if cfg.login_url.is_none() {
        missing.push("USER_CENTER_LOGIN_URL");
    }
    if cfg.client_id.is_none() {
        missing.push("USER_CENTER_CLIENT_ID");
    }
    if cfg.realm.is_none() {
        missing.push("USER_CENTER_REALM");
    }
    missing
}

fn callback_url(cfg: &Config) -> String {
    cfg.callback_url()
}

fn checklist(cfg: &Config, kind: LoginErrorKind) -> Vec<Step> {
    let login_ready = cfg.login_redirect().is_some();
    let missing = missing_login_env(cfg);
    let (login_status, login_detail) = if login_ready {
        let url = cfg.login_url.as_deref().unwrap_or("");
        (
            StepStatus::Configured,
            format!("登录页 {url}（clientId / realm / terminal 已齐）"),
        )
    } else {
        (
            StepStatus::Missing,
            format!(
                "缺少 {}。从省统筹门户点「数智疾控」回跳则不需要这三项",
                missing.join("、")
            ),
        )
    };

    let callback = callback_url(cfg);
    let openapi = &cfg.user_center_base_url;
    let (callback_status, callback_detail) = match kind {
        LoginErrorKind::NoLoginEntry | LoginErrorKind::LoggedOut => (
            StepStatus::Pending,
            format!("回调地址 {callback}，须在用户中心登记为 redirectUrl"),
        ),
        LoginErrorKind::MissingVerifyCode => (
            StepStatus::Failed,
            format!("已回到 {callback}，但 URL 里没有 verifyCode"),
        ),
        LoginErrorKind::InvalidState => (
            StepStatus::Failed,
            format!("已回到 {callback}，但 state 与发起登录的浏览器不一致"),
        ),
        LoginErrorKind::ExchangeFailed
        | LoginErrorKind::TenantDetailFailed
        | LoginErrorKind::InvalidUserId => (
            StepStatus::Done,
            format!("已回到 {callback}，并带上了 verifyCode"),
        ),
    };

    let (userinfo_status, userinfo_detail) = match kind {
        LoginErrorKind::ExchangeFailed => (
            StepStatus::Failed,
            format!(
                "{openapi}/sso/code/userInfo（先 {openapi}/auth/ticket）。请核对地址、网络、签名与 verifyCode"
            ),
        ),
        LoginErrorKind::TenantDetailFailed | LoginErrorKind::InvalidUserId => (
            StepStatus::Done,
            format!("{openapi}/sso/code/userInfo 已返回 userId / tenantId"),
        ),
        LoginErrorKind::MissingVerifyCode
        | LoginErrorKind::NoLoginEntry
        | LoginErrorKind::InvalidState
        | LoginErrorKind::LoggedOut => (
            StepStatus::Pending,
            format!(
                "{openapi}/sso/code/userInfo（先 {openapi}/auth/ticket）。有 verifyCode 后才会调用"
            ),
        ),
    };

    let (tenant_status, tenant_detail) = match kind {
        LoginErrorKind::TenantDetailFailed => (
            StepStatus::Failed,
            format!("{openapi}/console/tenant/detail，请求 tenantId，按 devisionType 读 provinceCode/cityCode/districtCode"),
        ),
        LoginErrorKind::InvalidUserId => (
            StepStatus::Pending,
            format!("{openapi}/console/tenant/detail。账号无效，未写入区域"),
        ),
        LoginErrorKind::ExchangeFailed
        | LoginErrorKind::MissingVerifyCode
        | LoginErrorKind::NoLoginEntry
        | LoginErrorKind::InvalidState
        | LoginErrorKind::LoggedOut => (
            StepStatus::Pending,
            format!(
                "{openapi}/console/tenant/detail。换到 tenantId 后再调，结果写入 X-User-Region"
            ),
        ),
    };

    let (enter_status, enter_detail) = match kind {
        LoginErrorKind::InvalidUserId => (
            StepStatus::Failed,
            "用户中心返回的 userId 无法用于工作台。模拟登录已关闭，没有备用入口".to_string(),
        ),
        _ => (
            StepStatus::Pending,
            "前面步骤都通过后，会写入会话并打开 /hbcdcagent/workbench。模拟登录已关闭".to_string(),
        ),
    };

    vec![
        Step {
            title: "跳转用户中心登录页",
            status: login_status,
            detail: login_detail,
        },
        Step {
            title: "回调带回 verifyCode",
            status: callback_status,
            detail: callback_detail,
        },
        Step {
            title: "换用户 /sso/code/userInfo",
            status: userinfo_status,
            detail: userinfo_detail,
        },
        Step {
            title: "查租户区域代码 /console/tenant/detail",
            status: tenant_status,
            detail: tenant_detail,
        },
        Step {
            title: "建立会话并进入工作台",
            status: enter_status,
            detail: enter_detail,
        },
    ]
}

fn render_steps(steps: &[Step]) -> String {
    let mut out = String::from("<ol class=\"steps\">");
    for (i, step) in steps.iter().enumerate() {
        out.push_str(&format!(
            "<li><span class=\"badge {}\">{}</span><div><strong>{}. {}</strong><p class=\"detail\">{}</p></div></li>",
            step.status.css(),
            step.status.label(),
            i + 1,
            escape_html(step.title),
            escape_html(&step.detail),
        ));
    }
    out.push_str("</ol>");
    out
}

fn render(cfg: &Config, kind: LoginErrorKind, state: Option<&str>) -> String {
    let (title, body) = kind.copy();
    let retry = cfg
        .login_redirect_with_state(state)
        .unwrap_or_else(|| Config::workbench_path().to_string());
    let href = escape_html_attr(&retry);
    let steps = render_steps(&checklist(cfg, kind));
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · 数智疾控</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #0b0f14; color: #e8edf4;
  }}
  main {{
    max-width: 40rem; margin: 2rem; padding: 2rem 1.75rem;
    border: 1px solid #243042; border-radius: 1rem; background: #121820;
  }}
  .brand {{ margin: 0 0 1rem; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: #8b9bb0; }}
  h1 {{ margin: 0 0 .75rem; font-size: 1.35rem; }}
  .lead {{ margin: 0 0 1.25rem; line-height: 1.65; color: #b4c0ce; }}
  .steps {{ list-style: none; margin: 0 0 1.5rem; padding: 0; }}
  .steps li {{
    display: grid; grid-template-columns: auto 1fr; gap: .4rem .75rem;
    padding: .7rem 0; border-top: 1px solid #243042; align-items: start;
  }}
  .steps li:last-child {{ border-bottom: 1px solid #243042; }}
  .badge {{
    display: inline-block; margin-top: .15rem; padding: .12rem .4rem;
    border-radius: .3rem; font-size: .7rem; font-weight: 700; letter-spacing: .04em;
    white-space: nowrap;
  }}
  .ok {{ background: #143d2a; color: #3dcc8a; }}
  .miss {{ background: #3d1a22; color: #ff7a90; }}
  .fail {{ background: #3d1a22; color: #ff7a90; }}
  .wait {{ background: #2a3140; color: #8b9bb0; }}
  strong {{ display: block; margin-bottom: .25rem; }}
  .detail {{ margin: 0; font-size: .85rem; line-height: 1.55; color: #8b9bb0; }}
  a.btn {{
    display: inline-block; padding: .55rem 1rem; border-radius: .6rem;
    background: #1d6fd8; color: #fff; text-decoration: none; font-weight: 600;
  }}
  a.btn:hover {{ background: #3b86e8; }}
</style>
</head>
<body>
<main>
  <p class="brand">数智疾控</p>
  <h1>{title}</h1>
  <p class="lead">{body}</p>
  {steps}
  <a class="btn" href="{href}">重新登录</a>
</main>
</body>
</html>
"#
    )
}

fn escape_html_attr(value: &str) -> String {
    escape_html(value)
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_href_escapes_query_ampersands() {
        let cfg = Config::for_test("http://uc", "http://up");
        let retry = cfg.login_redirect().expect("sso url");
        assert!(retry.contains('&'));
        let html = render(&cfg, LoginErrorKind::ExchangeFailed, None);
        assert!(html.contains("&amp;"));
        assert!(!html.contains(&format!("href=\"{retry}\"")));
        assert!(html.contains("重新登录"));
        assert!(html.contains("数智疾控"));
    }

    #[test]
    fn no_login_entry_lists_missing_sso_env() {
        let mut cfg = Config::for_test("http://88.7.129.9/openapi", "http://up");
        cfg.login_url = None;
        let html = render(&cfg, LoginErrorKind::NoLoginEntry, None);
        assert!(html.contains("无法进入工作台"));
        assert!(html.contains("USER_CENTER_LOGIN_URL"));
        assert!(html.contains("未配置"));
        assert!(html.contains("未执行"));
        assert!(html.contains("http://88.7.129.9/openapi"));
        assert!(html.contains("/hbcdcagent/auth/callback"));
        assert!(html.contains("/console/tenant/detail"));
        assert!(html.contains("查租户区域代码"));
        assert!(!html.contains("app-key"));
        assert!(!html.contains("bff-secret"));
    }

    #[test]
    fn exchange_failed_marks_userinfo_step() {
        let cfg = Config::for_test("http://uc", "http://up");
        let html = render(&cfg, LoginErrorKind::ExchangeFailed, None);
        assert!(html.contains("换用户 /sso/code/userInfo"));
        assert!(html.contains("查租户区域代码 /console/tenant/detail"));
        assert!(html.contains("失败"));
        assert!(html.contains("通过"));
        assert!(html.contains("未执行"));
    }

    #[test]
    fn tenant_detail_failed_marks_region_step() {
        let cfg = Config::for_test("http://uc", "http://up");
        let html = render(&cfg, LoginErrorKind::TenantDetailFailed, None);
        assert!(html.contains("卡住的是 /console/tenant/detail"));
        assert!(html.contains("devisionType"));
        assert!(html.contains("cityCode"));
        assert!(html.contains("失败"));
        assert!(html.contains("通过"));
    }
}
