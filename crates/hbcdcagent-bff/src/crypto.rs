//! SM4 + MD5/SM3 matching `docs/集成/用户中心集成工具类/SignUtil.java`.

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use cipher::{BlockDecryptMut, BlockEncryptMut, KeyInit, block_padding::Pkcs7};
use digest::Digest;
use md5::Md5;
use sm3::Sm3;
use sm4::Sm4;

/// Concatenate sign factors then `signType`, matching `SignUtil.sign`.
pub fn sign(sign_type: &str, factors: &[&str]) -> Result<String> {
    let mut buf = String::new();
    for part in factors {
        buf.push_str(part);
    }
    buf.push_str(sign_type);
    if sign_type.eq_ignore_ascii_case("SM3") {
        let digest = Sm3::digest(buf.as_bytes());
        Ok(hex::encode(digest).to_uppercase())
    } else if sign_type.eq_ignore_ascii_case("MD5") {
        let digest = Md5::digest(buf.as_bytes());
        Ok(hex::encode(digest))
    } else {
        bail!("unsupported signType {sign_type}");
    }
}

/// Encrypt UTF-8 plaintext; `app_secret` is a hex SM4 key. Returns Base64 (no wrap).
pub fn encrypt_data(app_secret: &str, plain: &str) -> Result<String> {
    let key = decode_sm4_key(app_secret)?;
    let encryptor = ecb::Encryptor::<Sm4>::new_from_slice(&key).context("SM4 encrypt key")?;
    let ciphertext = encryptor.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    Ok(BASE64.encode(ciphertext))
}

/// Decrypt Base64 ciphertext with hex `app_secret`.
pub fn decrypt_data(app_secret: &str, cipher_text: &str) -> Result<String> {
    let key = decode_sm4_key(app_secret)?;
    let ciphertext = BASE64
        .decode(cipher_text.trim().as_bytes())
        .context("SM4 ciphertext is not Base64")?;
    let decryptor = ecb::Decryptor::<Sm4>::new_from_slice(&key).context("SM4 decrypt key")?;
    let plain = decryptor
        .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
        .map_err(|_| anyhow::Error::msg("SM4 decrypt failed"))?;
    String::from_utf8(plain).context("SM4 plaintext is not UTF-8")
}

fn decode_sm4_key(app_secret: &str) -> Result<Vec<u8>> {
    let key = hex::decode(app_secret.trim()).context("appSecret is not hex")?;
    if key.len() != 16 {
        bail!("SM4 key must be 16 bytes (32 hex chars), got {}", key.len());
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn md5_sign_matches_java_factor_order() {
        let signed =
            sign("MD5", &["app", "ticket", "tsecret", "123", "secret", "key"]).expect("sign");
        let mut hasher = Md5::new();
        hasher.update(b"apptickettsecret123secretkeyMD5");
        assert_eq!(signed, hex::encode(hasher.finalize()));
    }

    #[test]
    fn sm4_roundtrip() {
        let plain = r#"{"verifyCode":"abc"}"#;
        let enc = encrypt_data(SECRET, plain).expect("encrypt");
        let dec = decrypt_data(SECRET, &enc).expect("decrypt");
        assert_eq!(dec, plain);
    }

    #[test]
    fn sm3_sign_is_uppercase_hex() {
        let signed = sign("SM3", &["app", "t", "s", "1", "sec", "key"]).expect("sign");
        assert_eq!(signed, signed.to_uppercase());
        assert_eq!(signed.len(), 64);
        let digest = Sm3::digest(b"appts1seckeySM3");
        assert_eq!(signed, hex::encode(digest).to_uppercase());
    }

    #[test]
    fn rejects_unknown_sign_type() {
        assert!(sign("SHA1", &["a"]).is_err());
    }

    #[test]
    fn rejects_bad_sm4_key() {
        assert!(encrypt_data("zz", "x").is_err());
        assert!(encrypt_data("0011", "x").is_err());
    }
}
