import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 智能预警（A）→ 智算疾控（B）免登票据签发。
 * JDK 8+ 原生 JCE，无第三方依赖。放到 A 后端，禁止进前端 / Git。
 *
 * 联调：clientId=CDSS-B-ZJJK-001，keyVersion=1。
 * 生产密钥线下另交，不要用下面这把联调密钥。
 */
public final class SsoTicketIssuer {

    public static final String CLIENT_ID = "CDSS-B-ZJJK-001";
    public static final int KEY_VERSION = 1;
    /** 标准 Base64，解码后 32 字节 = AES-256。仅联调。 */
    public static final String KEY_BASE64 = "luueY71IMszzt4bL8PocbEvkk1hXVpkY8Rpt2RxggUw=";
    public static final long TTL_MS = 300_000L;

    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private static final SecureRandom RANDOM = new SecureRandom();

    private SsoTicketIssuer() {}

    public static final class Ticket {
        public final String clientId;
        public final String verifyData;
        public final long expireAt;

        public Ticket(String clientId, String verifyData, long expireAt) {
            this.clientId = clientId;
            this.verifyData = verifyData;
            this.expireAt = expireAt;
        }
    }

    /**
     * 按当前登录用户签发一次性票据。timestamp / expireAt / nonce 在方法内生成，不要写死。
     * regionName、remark 可传 null。
     */
    public static Ticket issue(
            String userId,
            String userName,
            String nickName,
            String tenantId,
            String tenantCode,
            String tenantName,
            String regionCode,
            String regionName,
            String remark) {
        long now = System.currentTimeMillis();
        long expireAt = now + TTL_MS;
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("userId", required(userId, "userId"));
        payload.put("userName", required(userName, "userName"));
        payload.put("nickName", required(nickName, "nickName"));
        payload.put("tenantId", required(tenantId, "tenantId"));
        payload.put("tenantCode", required(tenantCode, "tenantCode"));
        payload.put("tenantName", required(tenantName, "tenantName"));
        payload.put("regionCode", required(regionCode, "regionCode"));
        if (regionName != null && !regionName.trim().isEmpty()) {
            payload.put("regionName", regionName.trim());
        }
        payload.put("timestamp", Long.valueOf(now));
        payload.put("expireAt", Long.valueOf(expireAt));
        payload.put("nonce", UUID.randomUUID().toString());
        if (remark != null && !remark.trim().isEmpty()) {
            payload.put("remark", remark.trim());
        }

        byte[] key = Base64.getDecoder().decode(KEY_BASE64);
        String json = toJson(payload);
        String verifyData = encrypt(key, KEY_VERSION, json, CLIENT_ID.getBytes(StandardCharsets.UTF_8));
        return new Ticket(CLIENT_ID, verifyData, expireAt);
    }

    /**
     * payload(UTF-8 JSON) → verifyData(Base64URL 无 padding)。
     * aad 必须传 clientId 的 UTF-8 字节，与 B 验票一致。
     */
    public static String encrypt(byte[] keyBytes, int keyVersion, String payload, byte[] aad) {
        try {
            byte[] iv = new byte[IV_LEN];
            RANDOM.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    Cipher.ENCRYPT_MODE,
                    new SecretKeySpec(keyBytes, "AES"),
                    new GCMParameterSpec(TAG_BITS, iv));
            if (aad != null) {
                cipher.updateAAD(aad);
            }
            byte[] cipherText = cipher.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            ByteBuffer buf = ByteBuffer.allocate(1 + IV_LEN + cipherText.length);
            buf.put((byte) keyVersion).put(iv).put(cipherText);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(buf.array());
        } catch (Exception e) {
            throw new IllegalStateException("SSO encrypt failed", e);
        }
    }

    /** 跳转：https://B域名/hbcdcagent/workbench/deepseek?clientId=...&verifyData=... */
    public static String jumpUrl(String bOrigin, Ticket ticket) {
        String origin = bOrigin.endsWith("/") ? bOrigin.substring(0, bOrigin.length() - 1) : bOrigin;
        return origin + "/hbcdcagent/workbench/deepseek?clientId=" + ticket.clientId
                + "&verifyData=" + ticket.verifyData;
    }

    static String toJson(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append('"').append(escape(e.getKey())).append('"').append(':');
            Object v = e.getValue();
            if (v instanceof Number) {
                sb.append(v.toString());
            } else {
                sb.append('"').append(escape(String.valueOf(v))).append('"');
            }
        }
        return sb.append('}').toString();
    }

    private static String required(String value, String field) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("payload missing " + field);
        }
        return value.trim();
    }

    private static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", Integer.valueOf(c)));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    /** 本地试跑：打印一份 payload JSON 和 verifyData。 */
    public static void main(String[] args) {
        Ticket t = issue(
                "U10001",
                "张三",
                "预警小张",
                "T001",
                "HUBEI_CDC",
                "湖北省疾控中心",
                "420000",
                "湖北省",
                "from-alert");
        System.out.println("clientId=" + t.clientId);
        System.out.println("expireAt=" + t.expireAt);
        System.out.println("verifyData=" + t.verifyData);
        System.out.println("jump=" + jumpUrl("https://B-ORIGIN", t));
    }
}
