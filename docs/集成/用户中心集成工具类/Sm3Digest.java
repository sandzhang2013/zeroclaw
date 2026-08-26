package com.mediway.cdc.openapi.gateway.util;

/**
 * Created by hjl
 *
 * @author hjl
 * @description Sm3Digest
 * @date 2019-11-28
 */
public class Sm3Digest {
    /**
     * SM3值的长度
     */
    private static final int BYTE_LENGTH = 32;

    /**
     * SM3分组长度
     */
    private static final int BLOCK_LENGTH = 64;

    /**
     * 缓冲区长度
     */
    private static final int BUFFER_LENGTH = BLOCK_LENGTH * 1;

    /**
     * 缓冲区
     */
    private byte[] xBuf = new byte[BUFFER_LENGTH];

    /**
     * 缓冲区偏移量
     */
    private int xBufOff;

    /**
     * 初始向量
     */
    private byte[] iv = {0x73, (byte) 0x80, 0x16, 0x6f, 0x49,
            0x14, (byte) 0xb2, (byte) 0xb9, 0x17, 0x24, 0x42, (byte) 0xd7,
            (byte) 0xda, (byte) 0x8a, 0x06, 0x00, (byte) 0xa9, 0x6f, 0x30,
            (byte) 0xbc, (byte) 0x16, 0x31, 0x38, (byte) 0xaa, (byte) 0xe3,
            (byte) 0x8d, (byte) 0xee, 0x4d, (byte) 0xb0, (byte) 0xfb, 0x0e,
            0x4e};

    private int cntBlock = 0;

    public Sm3Digest() {
    }

    public Sm3Digest(Sm3Digest t) {
        System.arraycopy(t.xBuf, 0, this.xBuf, 0, t.xBuf.length);
        this.xBufOff = t.xBufOff;
        System.arraycopy(t.iv, 0, this.iv, 0, t.iv.length);
    }

    /**
     * SM3结果输出
     *
     * @param out    保存SM3结构的缓冲区
     * @param outOff 缓冲区偏移量
     * @return
     */
    public int doFinal(byte[] out, int outOff) {
        byte[] tmp = doFinal();
        System.arraycopy(tmp, 0, out, 0, tmp.length);
        return BYTE_LENGTH;
    }

    public void reset() {
        xBufOff = 0;
        cntBlock = 0;
    }

    /**
     * 明文输入
     *
     * @param in    明文输入缓冲区
     * @param inOff 缓冲区偏移量
     * @param len   明文长度
     */
    public void update(byte[] in, int inOff, int len) {
        int partLen = BUFFER_LENGTH - xBufOff;
        int inputLen = len;
        int dPos = inOff;
        if (partLen < inputLen) {
            System.arraycopy(in, dPos, xBuf, xBufOff, partLen);
            inputLen -= partLen;
            dPos += partLen;
            doUpdate();
            while (inputLen > BUFFER_LENGTH) {
                System.arraycopy(in, dPos, xBuf, 0, BUFFER_LENGTH);
                inputLen -= BUFFER_LENGTH;
                dPos += BUFFER_LENGTH;
                doUpdate();
            }
        }

        System.arraycopy(in, dPos, xBuf, xBufOff, inputLen);
        xBufOff += inputLen;
    }

    private void doUpdate() {
        byte[] b = new byte[BLOCK_LENGTH];
        for (int i = 0; i < BUFFER_LENGTH; i += BLOCK_LENGTH) {
            System.arraycopy(xBuf, i, b, 0, b.length);
            doHash(b);
        }
        xBufOff = 0;
    }

    private void doHash(byte[] b) {
        byte[] tmp = Sm3.cf(iv, b);
        System.arraycopy(tmp, 0, iv, 0, iv.length);
        cntBlock++;
    }

    private byte[] doFinal() {
        byte[] b = new byte[BLOCK_LENGTH];
        byte[] buffer = new byte[xBufOff];
        System.arraycopy(xBuf, 0, buffer, 0, buffer.length);
        byte[] tmp = Sm3.padding(buffer, cntBlock);
        for (int i = 0; i < tmp.length; i += BLOCK_LENGTH) {
            System.arraycopy(tmp, i, b, 0, b.length);
            doHash(b);
        }
        return iv;
    }

    public void update(byte in) {
        byte[] buffer = new byte[]{in};
        update(buffer, 0, 1);
    }

    public int getDigestSize() {
        return BYTE_LENGTH;
    }

}
