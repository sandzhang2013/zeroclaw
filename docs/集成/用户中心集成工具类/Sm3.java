package com.mediway.cdc.openapi.gateway.util;

/**
 * Created by hjl
 *
 * @author hjl
 * @description Sm3
 * @date 2019-11-28
 */
public class Sm3 {

    private static final int INT_SIXTEEN = 16;

    private static final int INT_SIXTY_FOUR = 64;

    private static final int INT_FOUR = 4;

    private static final int INT_SIXTY_EIGHT = 68;

    private static final int INT_FIFTEEN = 15;

    private static final byte[] IV = {0x73, (byte) 0x80, 0x16, 0x6f, 0x49,
            0x14, (byte) 0xb2, (byte) 0xb9, 0x17, 0x24, 0x42, (byte) 0xd7,
            (byte) 0xda, (byte) 0x8a, 0x06, 0x00, (byte) 0xa9, 0x6f, 0x30,
            (byte) 0xbc, (byte) 0x16, 0x31, 0x38, (byte) 0xaa, (byte) 0xe3,
            (byte) 0x8d, (byte) 0xee, 0x4d, (byte) 0xb0, (byte) 0xfb, 0x0e,
            0x4e};

    private static final int[] TJ = new int[INT_SIXTY_FOUR];

    static {
        for (int i = 0; i < INT_SIXTEEN; i++) {
            TJ[i] = 0x79cc4519;
        }

        for (int i = INT_SIXTEEN; i < INT_SIXTY_FOUR; i++) {
            TJ[i] = 0x7a879d8a;
        }
    }

    public static byte[] cf(byte[] vs, byte[] bs) {
        int[] v, b;
        v = convert(vs);
        b = convert(bs);
        return convert(cf(v, b));
    }

    private static int[] convert(byte[] arr) {
        int[] out = new int[arr.length / 4];
        byte[] tmp = new byte[4];
        for (int i = 0; i < arr.length; i += INT_FOUR) {
            System.arraycopy(arr, i, tmp, 0, 4);
            out[i / 4] = bigEndianByteToInt(tmp);
        }
        return out;
    }

    private static byte[] convert(int[] arr) {
        byte[] out = new byte[arr.length * 4];
        byte[] tmp = null;
        for (int i = 0; i < arr.length; i++) {
            tmp = bigEndianIntToByte(arr[i]);
            System.arraycopy(tmp, 0, out, i * 4, 4);
        }
        return out;
    }

    public static int[] cf(int[] vs, int[] bs) {
        int a, b, c, d, e, f, g, h;
        int ss1, ss2, tt1, tt2;
        a = vs[0];
        b = vs[1];
        c = vs[2];
        d = vs[3];
        e = vs[4];
        f = vs[5];
        g = vs[6];
        h = vs[7];

        int[][] arr = expand(bs);
        int[] w = arr[0];
        int[] w1 = arr[1];

        for (int j = 0; j < INT_SIXTY_FOUR; j++) {
            ss1 = (bitCycleLeft(a, 12) + e + bitCycleLeft(TJ[j], j));
            ss1 = bitCycleLeft(ss1, 7);
            ss2 = ss1 ^ bitCycleLeft(a, 12);
            tt1 = fFj(a, b, c, j) + d + ss2 + w1[j];
            tt2 = gGj(e, f, g, j) + h + ss1 + w[j];
            d = c;
            c = bitCycleLeft(b, 9);
            b = a;
            a = tt1;
            h = g;
            g = bitCycleLeft(f, 19);
            f = e;
            e = p0(tt2);
        }

        int[] out = new int[8];
        out[0] = a ^ vs[0];
        out[1] = b ^ vs[1];
        out[2] = c ^ vs[2];
        out[3] = d ^ vs[3];
        out[4] = e ^ vs[4];
        out[5] = f ^ vs[5];
        out[6] = g ^ vs[6];
        out[7] = h ^ vs[7];

        return out;
    }

    private static int[][] expand(int[] b) {
        int[] w = new int[68];
        int[] w1 = new int[64];
        for (int i = 0; i < b.length; i++) {
            w[i] = b[i];
        }

        for (int i = INT_SIXTEEN; i < INT_SIXTY_EIGHT; i++) {
            w[i] = p1(w[i - 16] ^ w[i - 9] ^ bitCycleLeft(w[i - 3], 15))
                    ^ bitCycleLeft(w[i - 13], 7) ^ w[i - 6];
        }

        for (int i = 0; i < INT_SIXTY_FOUR; i++) {
            w1[i] = w[i] ^ w[i + 4];
        }

        int[][] arr = new int[][]{w, w1};
        return arr;
    }

    private static byte[] bigEndianIntToByte(int num) {
        return back(ByteConvertUtil.intToBytes(num));
    }

    private static int bigEndianByteToInt(byte[] bytes) {
        return ByteConvertUtil.byteToInt(back(bytes));
    }

    private static int fFj(int x, int y, int z, int j) {
        if (j >= 0 && j <= INT_FIFTEEN) {
            return fF1j(x, y, z);
        } else {
            return fF2j(x, y, z);
        }
    }

    private static int gGj(int x, int y, int z, int j) {
        if (j >= 0 && j <= INT_FIFTEEN) {
            return gG1j(x, y, z);
        } else {
            return gG2j(x, y, z);
        }
    }

    /**
     * 逻辑位运算函数
     * @param x
     * @param y
     * @param z
     * @return
     */
    private static int fF1j(int x, int y, int z) {
        int tmp = x ^ y ^ z;
        return tmp;
    }

    private static int fF2j(int x, int y, int z) {
        int tmp = ((x & y) | (x & z) | (y & z));
        return tmp;
    }

    private static int gG1j(int x, int y, int z) {
        int tmp = x ^ y ^ z;
        return tmp;
    }

    private static int gG2j(int x, int y, int z) {
        int tmp = (x & y) | (~x & z);
        return tmp;
    }

    private static int p0(int x) {
        int y = rotateLeft(x, 9);
        y = bitCycleLeft(x, 9);
        int z = rotateLeft(x, 17);
        z = bitCycleLeft(x, 17);
        int t = x ^ y ^ z;
        return t;
    }

    private static int p1(int x) {
        int t = x ^ bitCycleLeft(x, 15) ^ bitCycleLeft(x, 23);
        return t;
    }

    /**
     * 对最后一个分组字节数据padding
     *
     * @param in
     * @param bLen 分组个数
     * @return
     */
    public static byte[] padding(byte[] in, int bLen) {
        int k = 448 - (8 * in.length + 1) % 512;
        if (k < 0) {
            k = 960 - (8 * in.length + 1) % 512;
        }
        k += 1;
        byte[] padd = new byte[k / 8];
        padd[0] = (byte) 0x80;
        long n = in.length * 8 + bLen * 512;
        byte[] out = new byte[in.length + k / 8 + 64 / 8];
        int pos = 0;
        System.arraycopy(in, 0, out, 0, in.length);
        pos += in.length;
        System.arraycopy(padd, 0, out, pos, padd.length);
        pos += padd.length;
        byte[] tmp = back(ByteConvertUtil.longToBytes(n));
        System.arraycopy(tmp, 0, out, pos, tmp.length);
        return out;
    }

    /**
     * 字节数组逆序
     *
     * @param in
     * @return
     */
    private static byte[] back(byte[] in) {
        byte[] out = new byte[in.length];
        for (int i = 0; i < out.length; i++) {
            out[i] = in[out.length - i - 1];
        }

        return out;
    }

    public static int rotateLeft(int x, int n) {
        return (x << n) | (x >> (32 - n));
    }

    private static int bitCycleLeft(int n, int bitLen) {
        bitLen %= 32;
        byte[] tmp = bigEndianIntToByte(n);
        int byteLen = bitLen / 8;
        int len = bitLen % 8;
        if (byteLen > 0) {
            tmp = byteCycleLeft(tmp, byteLen);
        }

        if (len > 0) {
            tmp = bitSmall8CycleLeft(tmp, len);
        }

        return bigEndianByteToInt(tmp);
    }

    private static byte[] bitSmall8CycleLeft(byte[] in, int len) {
        byte[] tmp = new byte[in.length];
        int t1, t2, t3;
        for (int i = 0; i < tmp.length; i++) {
            t1 = (byte) ((in[i] & 0x000000ff) << len);
            t2 = (byte) ((in[(i + 1) % tmp.length] & 0x000000ff) >> (8 - len));
            t3 = (byte) (t1 | t2);
            tmp[i] = (byte) t3;
        }

        return tmp;
    }

    private static byte[] byteCycleLeft(byte[] in, int byteLen) {
        byte[] tmp = new byte[in.length];
        System.arraycopy(in, byteLen, tmp, 0, in.length - byteLen);
        System.arraycopy(in, 0, tmp, in.length - byteLen, byteLen);
        return tmp;
    }
}
