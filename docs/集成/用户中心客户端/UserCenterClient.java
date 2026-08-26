package com.mediway.cdc.openapi.gateway.client;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.mediway.cdc.openapi.gateway.util.SignUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * 省统筹 Java 服务调用用户中心：应用 ticket 池 + 按 verifyCode 换用户。
 * 与 {@code docs/集成/用户中心集成工具类} 同 classpath。
 * 150 工作台主机无 JVM 时用 {@code crates/hbcdcagent-bff}；不要把签密写进 zeroclaw daemon，
 * 不要把密钥配进 {@code ~/.zeroclaw/config.toml}。
 *
 * <p>登录回跳示例（省统筹自己的 Controller）：
 *
 * <pre>
 * TokenUserInfo info = userCenter.getUserInfoByVerifyCode(verifyCode);
 * // 写入平台 session 后 302 到 /hbcdcagent/workbench
 * </pre>
 */
public final class UserCenterClient {

    private static final Logger log = LoggerFactory.getLogger(UserCenterClient.class);

    /** ticket 默认 15 分钟有效；提前刷新，避免业务请求踩过期。 */
    private static final Duration REFRESH_AFTER = Duration.ofMinutes(10);

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(20);

    private final UserCenterProperties props;
    private final HttpClient http;

    private final Object ticketLock = new Object();
    private AuthTicket ticket;
    private Instant ticketAt;

    public UserCenterClient(UserCenterProperties props) {
        this.props = props;
        this.http = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build();
    }

    /**
     * 拿到当前有效 ticket。首次调用 {@code POST /auth/ticket}；超过 10 分钟则 {@code POST /auth/refresh}。
     */
    public AuthTicket ensureTicket() {
        synchronized (ticketLock) {
            if (ticket == null) {
                fetchNewTicketLocked();
                return ticket;
            }
            if (ticketAt != null && Instant.now().isAfter(ticketAt.plus(REFRESH_AFTER))) {
                try {
                    refreshTicketLocked();
                } catch (UserCenterException e) {
                    if (e.refreshTicketExpired()) {
                        log.warn("refreshTicket 已失效，重新获取 ticket");
                        fetchNewTicketLocked();
                    } else {
                        throw e;
                    }
                }
            }
            return ticket;
        }
    }

    /** 主动刷新。供 Spring {@code @Scheduled(fixedDelay = 600_000)} 调用。 */
    public AuthTicket refreshTicket() {
        synchronized (ticketLock) {
            if (ticket == null) {
                fetchNewTicketLocked();
                return ticket;
            }
            try {
                refreshTicketLocked();
            } catch (UserCenterException e) {
                if (e.refreshTicketExpired()) {
                    fetchNewTicketLocked();
                } else {
                    throw e;
                }
            }
            return ticket;
        }
    }

    /**
     * {@code POST /sso/code/userInfo}：用统一登录回跳的 verifyCode 换用户会话。
     * ticket 失效时刷新或重拿后重试一次。
     */
    public TokenUserInfo getUserInfoByVerifyCode(String verifyCode) {
        if (verifyCode == null || verifyCode.trim().isEmpty()) {
            throw new UserCenterException("UC0001", "缺少 verifyCode");
        }
        JSONObject biz = new JSONObject();
        biz.put("verifyCode", verifyCode.trim());
        JSONObject data = invokeBiz("/sso/code/userInfo", biz, true);
        return data.toJavaObject(TokenUserInfo.class);
    }

    private void fetchNewTicketLocked() {
        JSONObject body = new JSONObject();
        body.put("appId", props.getAppId());
        body.put("appSecret", props.getAppSecret());
        JSONObject root = postJson(props.url("/auth/ticket"), body.toJSONString());
        assertGatewayOk(root);
        JSONObject plain = decryptDataObject(root.get("data"));
        if (plain == null) {
            throw new UserCenterException("UC0104", "获取票据失败：data 无法解密");
        }
        AuthTicket next = plain.toJavaObject(AuthTicket.class);
        if (next == null || isBlank(next.ticket) || isBlank(next.ticketSecret) || isBlank(next.refreshTicket)) {
            throw new UserCenterException("UC0104", "获取票据失败：解密结果缺少字段");
        }
        this.ticket = next;
        this.ticketAt = Instant.now();
        log.info("已获取用户中心 ticket");
    }

    private void refreshTicketLocked() {
        if (ticket == null || isBlank(ticket.refreshTicket)) {
            fetchNewTicketLocked();
            return;
        }
        JSONObject body = new JSONObject();
        body.put("refreshTicket", ticket.refreshTicket);
        JSONObject root = postJson(props.url("/auth/refresh"), body.toJSONString());
        assertGatewayOk(root);
        Object data = root.get("data");
        if (data instanceof String && !((String) data).isEmpty()) {
            JSONObject plain = decryptDataObject(data);
            AuthTicket next = plain.toJavaObject(AuthTicket.class);
            if (next != null && !isBlank(next.ticket)) {
                this.ticket = next;
            }
        }
        this.ticketAt = Instant.now();
        log.info("已刷新用户中心 ticket");
    }

    private JSONObject invokeBiz(String path, JSONObject biz, boolean retryOnExpiredTicket) {
        AuthTicket current = ensureTicket();
        String encodeData = SignUtil.encryptData(props.getAppSecret(), biz.toJSONString());
        JSONObject body = new JSONObject();
        body.put("encodeData", encodeData);

        String timeStamp = Long.toString(System.currentTimeMillis());
        String requestId = UUID.randomUUID().toString().replace("-", "");
        String sign =
                SignUtil.sign(
                        props.getSignType(),
                        props.getAppId(),
                        current.ticket,
                        current.ticketSecret,
                        timeStamp,
                        props.getAppSecret(),
                        props.getAppKey());

        HttpRequest.Builder req =
                HttpRequest.newBuilder(URI.create(props.url(path)))
                        .timeout(REQUEST_TIMEOUT)
                        .header("Content-Type", "application/json; charset=UTF-8")
                        .header("appId", props.getAppId())
                        .header("sign", sign)
                        .header("signType", props.getSignType())
                        .header("ticket", current.ticket)
                        .header("requestId", requestId)
                        .header("timeStamp", timeStamp)
                        .header("timestamp", timeStamp)
                        .POST(HttpRequest.BodyPublishers.ofString(body.toJSONString(), StandardCharsets.UTF_8));

        JSONObject root = send(req.build());
        String retCode = retCodeOf(root);
        if ("GW0003".equals(retCode) && retryOnExpiredTicket) {
            log.warn("ticket 已失效，刷新后重试 {}", path);
            synchronized (ticketLock) {
                try {
                    refreshTicketLocked();
                } catch (UserCenterException e) {
                    if (e.refreshTicketExpired()) {
                        fetchNewTicketLocked();
                    } else {
                        throw e;
                    }
                }
            }
            return invokeBiz(path, biz, false);
        }
        assertGatewayOk(root);
        JSONObject data = decryptDataObject(root.get("data"));
        if (data == null) {
            throw new UserCenterException(retCode, "业务响应 data 为空");
        }
        return data;
    }

    private JSONObject postJson(String url, String jsonBody) {
        HttpRequest request =
                HttpRequest.newBuilder(URI.create(url))
                        .timeout(REQUEST_TIMEOUT)
                        .header("Content-Type", "application/json; charset=UTF-8")
                        .header("appId", props.getAppId())
                        .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                        .build();
        return send(request);
    }

    private JSONObject send(HttpRequest request) {
        try {
            HttpResponse<String> response =
                    http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String raw = response.body() == null ? "" : response.body();
            JSONObject root;
            try {
                root = JSON.parseObject(raw);
            } catch (Exception parse) {
                throw new UserCenterException(
                        "HTTP" + response.statusCode(), "用户中心返回非 JSON，HTTP " + response.statusCode());
            }
            if (root == null) {
                throw new UserCenterException("HTTP" + response.statusCode(), "用户中心返回空 JSON");
            }
            if (response.statusCode() >= 400 && !root.containsKey("retCode")) {
                throw new UserCenterException("HTTP" + response.statusCode(), "用户中心 HTTP " + response.statusCode());
            }
            return root;
        } catch (UserCenterException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new UserCenterException("GW0000", "调用用户中心被中断");
        } catch (Exception e) {
            throw new UserCenterException("GW0000", "调用用户中心失败: " + e.getClass().getSimpleName());
        }
    }

    private void assertGatewayOk(JSONObject root) {
        String retCode = retCodeOf(root);
        boolean ok =
                root.getBooleanValue("success")
                        || "SUCCESS".equalsIgnoreCase(retCode)
                        || "999999".equals(retCode);
        if (!ok) {
            throw new UserCenterException(retCode, root.getString("retMsg"));
        }
    }

    private JSONObject decryptDataObject(Object data) {
        if (data == null) {
            return null;
        }
        if (data instanceof JSONObject) {
            return (JSONObject) data;
        }
        if (data instanceof String) {
            String cipher = ((String) data).trim();
            if (cipher.isEmpty()) {
                return null;
            }
            String plain = SignUtil.decryptData(props.getAppSecret(), cipher);
            return JSON.parseObject(plain);
        }
        return JSON.parseObject(JSON.toJSONString(data));
    }

    private static String retCodeOf(JSONObject root) {
        String code = root.getString("retCode");
        if (code != null) {
            return code;
        }
        Object raw = root.get("retCode");
        return raw == null ? "" : String.valueOf(raw);
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    /** {@code POST /auth/ticket} 解密后的应用票据。不要写入用户 session，不要下发浏览器。 */
    public static final class AuthTicket {
        public String ticket;
        public String ticketSecret;
        public String refreshTicket;
    }

    /** {@code POST /sso/code/userInfo} 解密后的会话与用户。 */
    public static final class TokenUserInfo {
        public String accessToken;
        public String refreshToken;
        public Long accessExpireDate;
        public Long refreshExpireDate;
        public UserInfo userInfo;
    }

    public static final class UserInfo {
        public String userId;
        public String accountName;
        public String realName;
        public String gender;
        public String nickName;
        public String tenantId;
        public String tenantName;
        public String departmentCode;
        public String departmentName;
    }
}
