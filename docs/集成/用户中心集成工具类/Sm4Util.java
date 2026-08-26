/*
 * Copyright 2019 mediway
 *
 */

package com.mediway.cdc.openapi.gateway.util;

import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.util.encoders.Base64;
import org.bouncycastle.util.encoders.Hex;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Provider;
import java.security.Security;

 /**
 * Created by hjl
 *
 * @author hjl
 * @description SM4加解密工具类
 * @date 2019-11-28
 */
public class Sm4Util {
    
    private static final Logger logger = LoggerFactory.getLogger(Sm4Util.class);
    
    /**
     * SM4算法
     */
    private static final String ALGORITHM = "SM4";
    
    /**
     * 分块模式和填充模式
     */
    private static final String CIPHER = "SM4/ECB/PKCS5Padding";

     /**
      * 打包方式
      */
    private static final String PACKING_TYPE = "jar";
    
    static {
        Provider bcp = null;
        
        if (null == Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)) {
            logger.info("未找到BC，进行加载");
            try {
                ClassLoader cl = Sm4Util.class.getClassLoader();
                logger.info("Class Loader: {}", cl);
                URL url =  cl.getResource("org/bouncycastle/jce/provider/BouncyCastleProvider.class");
                if (PACKING_TYPE.equals(url.getProtocol())) {
                    url = new URL(url.getPath().substring(0, url.getPath().indexOf('!')));
                    cl = new URLClassLoader(new URL[]{url}, null);
                    logger.info("Class Loader: {}", cl);
                    Class<?> cls = cl.loadClass("org.bouncycastle.jce.provider.BouncyCastleProvider");
                    bcp = (Provider) cls.newInstance();
                }
            } catch (Exception ignored) {
                logger.error(ignored.getMessage());
            }
            if (bcp == null) {
                bcp = new BouncyCastleProvider();
            }
            
            Security.addProvider(bcp);
        } else {
            logger.info("已找到BC，无需加载");
        }
    }
    
    /**
     * 
     * <p>加密</p>
     * <p>使用字节数组作为参数</p>
     *
     * @param key 密钥字节数组
     * @param content 内容字节数组
     * @return
     * @throws GeneralSecurityException
     * @created 2019-08-28 14:59:37
     */
    private static byte[] encrypt(byte[] key, byte[] content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();
        Cipher sm4Engine = Cipher.getInstance(CIPHER, BouncyCastleProvider.PROVIDER_NAME);       
        SecretKeySpec keySpec = new SecretKeySpec(key, ALGORITHM);
        sm4Engine.init(Cipher.ENCRYPT_MODE, keySpec);
        long endTime = System.currentTimeMillis();
        logger.info("sm4，字节数组加密耗时{}",(endTime-startTime));
        return sm4Engine.doFinal(content);
    }
    
    /**
     * 
     * <p>加密</p>
     * <p>使用Base64编码字符串作为密文</p>
     * @param key
     * @param content
     * @return 密文（Base64编码）
     * @throws GeneralSecurityException
     * @created 2019-08-28 15:53:27
     */
    public static String encryptToBase64(byte[] key, byte[] content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();
        byte[] ciphertext = encrypt(key, content);
        String retStr = Base64.toBase64String(ciphertext);
        long endTime = System.currentTimeMillis();
        logger.info("sm4，Base64编码加密耗时{}",(endTime-startTime));
        return retStr;
    }
    
    /**
     * 
     * <p>加密</p>
     * <p>使用字符串作为参数</p>
     *
     * @param key 密钥（16进制字符串）
     * @param content 内容（明文）
     * @return 密文（Base64编码）
     * @throws GeneralSecurityException
     * @created 2019-08-28 15:03:21
     */
    public static String encryptToBase64(String key, String content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();

        byte[] contentBytes = content.getBytes(StandardCharsets.UTF_8);
        byte[] keyBytes = Hex.decode(key);
        
        byte[] ciphertext = encrypt(keyBytes, contentBytes);
        String retStr =Base64.toBase64String(ciphertext);
        long endTime = System.currentTimeMillis();
        logger.info("sm4字符串加密耗时{}",(endTime-startTime));

        return retStr;
    }
    
    /**
     * 
     * <p>解密</p>
     * <p>使用字节数组作为参数</p>
     *
     * @param key
     * @param content
     * @return 明文
     * @throws GeneralSecurityException
     * @created 2019-08-28 15:52:25
     */
    private static String doDecrypt(byte[] key, byte[] content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();

        Cipher sm4Engine = Cipher.getInstance(CIPHER, BouncyCastleProvider.PROVIDER_NAME);
        
        SecretKeySpec keySpec = new SecretKeySpec(key, ALGORITHM);
        sm4Engine.init(Cipher.DECRYPT_MODE, keySpec);
        
        byte[] bytes = sm4Engine.doFinal(content);
        String retStr = new String(bytes, StandardCharsets.UTF_8);
        long endTime = System.currentTimeMillis();
        logger.info("sm4字节数组解密耗时{}",(endTime-startTime));

        return retStr;
    }
    
    /**
     * 
     * <p>解密</p>
     * <p>使用Base64编码字符串作为密文</p>
     *
     * @param key
     * @param content
     * @return 明文（字节数组）
     * @throws GeneralSecurityException
     * @created 2019-08-28 15:54:14
     */
    public static String decryptFromBase64(byte[] key, String content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();

        byte[] bytes = Base64.decode(content);
        String retStr = doDecrypt(key, bytes);
        long endTime = System.currentTimeMillis();
        logger.info("sm4，Base64解密耗时，key为数组{}",(endTime-startTime));

        return retStr;
    }
    
    /**
     * 
     * <p>解密</p>
     * <p>使用Base64编码字符串作为密文</p>
     *
     * @param key 密钥（16进制字符串）
     * @param content 密文（Base64编码）
     * @return 明文
     * @throws GeneralSecurityException
     * @created 2019-08-28 15:54:14
     */
    public static String decryptFromBase64(String key, String content) throws GeneralSecurityException {
        long startTime = System.currentTimeMillis();

        byte[] keyBytes = Hex.decode(key);
        byte[] contentBytes = Base64.decode(content);
        String retStr = doDecrypt(keyBytes, contentBytes);
        long endTime = System.currentTimeMillis();
        logger.info("sm4，Base64解密耗时,key为字符串{}",(endTime-startTime));

        return retStr;
    }
    
    private Sm4Util() {}

}
