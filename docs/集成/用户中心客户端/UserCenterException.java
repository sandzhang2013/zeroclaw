package com.mediway.cdc.openapi.gateway.client;

/**
 * 用户中心网关或业务错误。{@link #getRetCode()} 为 GW**** / UC**** / HTTP 状态。
 */
public final class UserCenterException extends RuntimeException {

    private final String retCode;

    public UserCenterException(String retCode, String message) {
        super(message == null || message.isEmpty() ? retCode : retCode + ": " + message);
        this.retCode = retCode == null ? "" : retCode;
    }

    public String getRetCode() {
        return retCode;
    }

    public boolean ticketExpired() {
        return "GW0003".equals(retCode);
    }

    public boolean refreshTicketExpired() {
        return "GW0007".equals(retCode);
    }
}
