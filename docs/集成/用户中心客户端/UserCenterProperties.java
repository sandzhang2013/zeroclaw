package com.mediway.cdc.openapi.gateway.client;

/**
 * 用户中心后台参数。只放在省统筹 Java 服务的环境变量 / 密钥柜，不要写进 ZeroClaw config。
 *
 * <pre>
 * USER_CENTER_BASE_URL=http://<用户中心域名或IP>/openapi
 * USER_CENTER_APP_ID=...
 * USER_CENTER_APP_KEY=...
 * USER_CENTER_APP_SECRET=...
 * USER_CENTER_SIGN_TYPE=MD5
 * </pre>
 */
public final class UserCenterProperties {

    private final String baseUrl;
    private final String appId;
    private final String appKey;
    private final String appSecret;
    private final String signType;

    public UserCenterProperties(
            String baseUrl, String appId, String appKey, String appSecret, String signType) {
        this.baseUrl = trimTrailingSlash(required(baseUrl, "USER_CENTER_BASE_URL"));
        this.appId = required(appId, "USER_CENTER_APP_ID");
        this.appKey = required(appKey, "USER_CENTER_APP_KEY");
        this.appSecret = required(appSecret, "USER_CENTER_APP_SECRET");
        String type = signType == null || signType.trim().isEmpty() ? "MD5" : signType.trim();
        if (!"MD5".equalsIgnoreCase(type) && !"SM3".equalsIgnoreCase(type)) {
            throw new IllegalArgumentException("USER_CENTER_SIGN_TYPE 只能是 MD5 或 SM3");
        }
        this.signType = type.toUpperCase();
    }

    public static UserCenterProperties fromEnv() {
        return new UserCenterProperties(
                System.getenv("USER_CENTER_BASE_URL"),
                System.getenv("USER_CENTER_APP_ID"),
                System.getenv("USER_CENTER_APP_KEY"),
                System.getenv("USER_CENTER_APP_SECRET"),
                System.getenv("USER_CENTER_SIGN_TYPE"));
    }

    public String url(String path) {
        return baseUrl + (path.startsWith("/") ? path : "/" + path);
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public String getAppId() {
        return appId;
    }

    public String getAppKey() {
        return appKey;
    }

    public String getAppSecret() {
        return appSecret;
    }

    public String getSignType() {
        return signType;
    }

    private static String required(String value, String name) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少 " + name);
        }
        return value.trim();
    }

    private static String trimTrailingSlash(String url) {
        if (url.endsWith("/")) {
            return url.substring(0, url.length() - 1);
        }
        return url;
    }
}
