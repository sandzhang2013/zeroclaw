package com.mediway.cdc.openapi.gateway.util;

import com.mediway.cdc.openapi.gateway.base.GatewayErrorCodeEnum;
import com.mediway.cdc.core.base.exception.AppException;
import lombok.extern.slf4j.Slf4j;
import org.bouncycastle.util.encoders.Hex;

import java.io.UnsupportedEncodingException;
import java.security.GeneralSecurityException;
import java.util.UUID;

import static com.mediway.cdc.openapi.gateway.util.Sm4Util.encryptToBase64;

/**
 * Created by hjl
 *
 * @author hjl
 * @description 签名工具类
 * @date 2019-11-28
 */
@Slf4j
public class SignUtil {

	public final static String SIGN_SM3 = "SM3";

    public final static String SIGN_MD5 = "MD5";

    private static final String CHARTSET_NAME = "UTF-8";

    /**
     * 生成签名方法
     * @param signType 签名类型
     * @param strings 签名因子
     * @return
     */
    public static String sign(String signType,String ...strings) {
        String afterSign;
		try {
		    long startTime = System.currentTimeMillis();

			int length = strings.length;
			if (0 == length){
				log.info("未输入有效签名参数");
			    throw new AppException("","请输入有效参数");
			}

			StringBuilder sb = new StringBuilder();
			for(int i=0;i<length;i++) {
				sb.append(strings[i]);
			}
			String beforeSignStr = sb.append(signType).toString();
			afterSign = "";
			log.info("签名前字符串：{}",beforeSignStr);

			if(SIGN_SM3.equalsIgnoreCase(signType)) {
				afterSign = getSm3Sign(beforeSignStr);
			}else {
				afterSign = getMd5Sign(beforeSignStr);
			}
	         long endTime = System.currentTimeMillis();

			log.info("签名后字符串：{},耗时毫秒{}",afterSign,(endTime-startTime));
		} catch (Exception e) {
			log.info("签名失败");
			throw new AppException(GatewayErrorCodeEnum.ERROR_GW_0006);
		}
        return afterSign;
    }

    /**
     * 生成签名
     *
     * @param str 需要签名的参数
     * @return
     * @throws Exception
     */
    private static String getMd5Sign(String str) throws Exception {
        return Md5Util.md5(str, "");
    }

    private static String getSm3Sign(String str) throws UnsupportedEncodingException {
        byte[] md = new byte[32];
        byte[] msg1 = str.getBytes(CHARTSET_NAME);
        Sm3Digest sm3 = new Sm3Digest();
        sm3.update(msg1, 0, msg1.length);
        sm3.doFinal(md, 0);
        String s = new String(Hex.encode(md), CHARTSET_NAME);
        return s.toUpperCase();
    }

    /**
     * 加密数据
     *
     * @param appSecret 对称加密秘钥
     * @param plainText 对象数据
     * @return
     */
    public static String encryptData(String appSecret, String plainText) {
        long startTime = System.currentTimeMillis();

        log.info("[加密数据开始]:plainText={}", plainText);
        String cipherText = null;
        try {
            cipherText = Sm4Util.encryptToBase64(appSecret, plainText);
        } catch (GeneralSecurityException e) {
            log.error("[加密失败]", e);
            throw new AppException("", "加密失败");
        }
        long endTime = System.currentTimeMillis();

        log.info("[加密数据完成]:cipherText={},耗时：{}", cipherText,(endTime-startTime));
        return cipherText;
    }

    /**
     * 解密数据
     * @param appSecret 对称加密秘钥
     * @param cipherText 加密数据
     * @return
     */
    public static String decryptData(String appSecret, String cipherText) {
        long startTime = System.currentTimeMillis();

        log.info("[解密数据开始]:cipherText={}", cipherText);
        String plainText = null;
        try {
            plainText = Sm4Util.decryptFromBase64(appSecret, cipherText);
        } catch (GeneralSecurityException e) {
            log.error("[解密失败]", e);
            throw new AppException("", "解密失败");
        }
        long endTime = System.currentTimeMillis();

        log.info("[解密数据完成]:plainText={},耗时：{}", plainText,(endTime-startTime));
        return plainText;
    }

    public static void main(String[] args) {
        // 示例：本地随机生成 appId / appKey / appSecret，供对接调试用。
        String appId = UUID.randomUUID().toString().replace("-", "");
        String appKey = UUID.randomUUID().toString().replace("-", "");
        String appSecret = UUID.randomUUID().toString().toUpperCase().replace("-", "");
        System.out.println(appId + " " + appKey + " " + appSecret);
    }
}
