//! giojs-server/src/session_token.rs
//!
//! Verification of `@gio.js/core` session cookies for `require_session`
//! guards. The token format and key derivation are defined in
//! packages/giojs-core/src/session.ts:
//!
//! ```text
//! v1.<exp>.<payload>.<mac>
//! mac = base64url(HMAC-SHA256(macKey, "<cookie name>\nv1.<exp>.<payload>"))
//! macKey = HKDF-SHA256(ikm = secret, salt = empty, info = "gio-session-mac")
//! ```
//!
//! Rust never decrypts the payload: authenticity (the MAC, compared in
//! constant time, against every rotated secret) and expiry are all a guard
//! needs, and the encryption key never has to leave Node. Secrets come from
//! GIO_SESSION_SECRET (comma-separated, first signs, all verify, each at
//! least 32 bytes) - the same parsing as session.ts. In development without
//! one, the server generates an ephemeral secret and hands it to the worker,
//! so Rust and Node always agree and sessions survive worker restarts.

use std::fmt;
use std::sync::{Arc, OnceLock};

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use thiserror::Error;
use tracing::{error, info};

pub const DEFAULT_COOKIE_NAME: &str = "gio_session";
pub const SECRET_ENV: &str = "GIO_SESSION_SECRET";
/// Tells the worker its GIO_SESSION_SECRET is the dev server's ephemeral one.
const EPHEMERAL_ENV: &str = "GIO_SESSION_SECRET_EPHEMERAL";
const MIN_SECRET_BYTES: usize = 32;
const MAC_INFO: &[u8] = b"gio-session-mac";
const TOKEN_VERSION: &str = "v1";
const MAC_BYTES: usize = 32;
/// Browsers cap a cookie at 4096 bytes; anything longer is not ours and is
/// rejected before hashing.
const MAX_TOKEN_BYTES: usize = 4096;
/// Unix seconds, no leading zeros - session.ts writes exactly this form.
const MAX_EXP_DIGITS: usize = 15;

pub const SECRET_GENERATE_HINT: &str =
    "node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SecretError {
    #[error("{} is empty", SECRET_ENV)]
    Empty,
    #[error(
        "{} secret #{index} is {len} bytes; at least {} are required",
        SECRET_ENV,
        MIN_SECRET_BYTES
    )]
    TooShort { index: usize, len: usize },
}

/// HMAC keys derived from every configured secret, signing secret first.
pub struct SessionKeys {
    mac_keys: Vec<[u8; 32]>,
}

impl fmt::Debug for SessionKeys {
    // Never print key material.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionKeys")
            .field("keys", &self.mac_keys.len())
            .finish()
    }
}

impl SessionKeys {
    /// Parse a GIO_SESSION_SECRET value: comma-separated, entries trimmed,
    /// empty entries ignored, each at least 32 bytes.
    pub fn from_secret_list(raw: &str) -> Result<Self, SecretError> {
        let secrets: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
            .collect();
        if secrets.is_empty() {
            return Err(SecretError::Empty);
        }
        let mut mac_keys = Vec::with_capacity(secrets.len());
        for (index, secret) in secrets.iter().enumerate() {
            if secret.len() < MIN_SECRET_BYTES {
                return Err(SecretError::TooShort {
                    index: index + 1,
                    len: secret.len(),
                });
            }
            mac_keys.push(derive_mac_key(secret));
        }
        Ok(SessionKeys { mac_keys })
    }

    /// True when `token` is a well-formed, unexpired session token for the
    /// cookie `cookie_name`, signed by any configured secret.
    pub fn verify(&self, cookie_name: &str, token: &str, now_unix: u64) -> bool {
        if token.len() > MAX_TOKEN_BYTES {
            return false;
        }
        let Some((signed, mac_text)) = token.rsplit_once('.') else {
            return false;
        };
        let mut parts = signed.split('.');
        let (Some(version), Some(exp_text), Some(payload), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        if version != TOKEN_VERSION || payload.is_empty() || !is_base64url(payload) {
            return false;
        }
        let Some(exp) = parse_exp(exp_text) else {
            return false;
        };
        if now_unix >= exp {
            return false;
        }
        let Some(provided) = decode_mac(mac_text) else {
            return false;
        };
        let mut valid = false;
        for key in &self.mac_keys {
            let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(key) else {
                return false;
            };
            mac.update(cookie_name.as_bytes());
            mac.update(b"\n");
            mac.update(signed.as_bytes());
            // verify_slice compares in constant time; every key is tried.
            valid |= mac.verify_slice(&provided).is_ok();
        }
        valid
    }
}

fn derive_mac_key(secret: &str) -> [u8; 32] {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, secret.as_bytes())
        .expand(MAC_INFO, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

fn parse_exp(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let well_formed = !bytes.is_empty()
        && bytes.len() <= MAX_EXP_DIGITS
        && bytes[0] != b'0'
        && bytes.iter().all(u8::is_ascii_digit);
    if well_formed {
        text.parse().ok()
    } else {
        None
    }
}

fn is_base64url(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn base64url_value(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Decode the canonical unpadded base64url spelling of a 32-byte MAC (43
/// characters, unused low bits zero). Local decoder: no base64 crate is
/// approved in the workspace (see ws_ipc.rs).
fn decode_mac(text: &str) -> Option<[u8; MAC_BYTES]> {
    let bytes = text.as_bytes();
    if bytes.len() != 43 {
        return None;
    }
    let mut out = [0u8; MAC_BYTES];
    let mut written = 0;
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        acc = (acc << 6) | base64url_value(byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out[written] = (acc >> bits) as u8;
            written += 1;
            acc &= (1 << bits) - 1;
        }
    }
    // 43 * 6 = 258 bits: two leftover bits that must be zero.
    (written == MAC_BYTES && acc == 0).then_some(out)
}

/// The process-wide secret state, decided once at startup.
#[derive(Debug, Default)]
struct SessionSecrets {
    keys: Option<Arc<SessionKeys>>,
    /// Dev only: generated because GIO_SESSION_SECRET was unset.
    ephemeral_secret: Option<String>,
}

impl SessionSecrets {
    /// Invalid secrets are an error log, not a startup failure: require_session
    /// guards then deny every request (fail closed) and the rest of the site
    /// keeps working, while session.ts throws on the same value.
    fn resolve(raw: &str, dev_mode: bool) -> Self {
        if raw.split(',').all(|secret| secret.trim().is_empty()) {
            if !dev_mode {
                return SessionSecrets::default();
            }
            let secret = crate::ipc::generate_token();
            info!(
                "{SECRET_ENV} not set - using an ephemeral development session secret (sessions reset when the server restarts)"
            );
            return SessionSecrets {
                keys: SessionKeys::from_secret_list(&secret).ok().map(Arc::new),
                ephemeral_secret: Some(secret),
            };
        }
        match SessionKeys::from_secret_list(raw) {
            Ok(keys) => SessionSecrets {
                keys: Some(Arc::new(keys)),
                ephemeral_secret: None,
            },
            Err(e) => {
                error!(
                    error = %e,
                    "invalid session secret - require_session guards deny every request. Generate one with: {SECRET_GENERATE_HINT}"
                );
                SessionSecrets::default()
            }
        }
    }

    fn worker_env(&self) -> Vec<(&'static str, String)> {
        match &self.ephemeral_secret {
            Some(secret) => vec![
                (SECRET_ENV, secret.clone()),
                (EPHEMERAL_ENV, "1".to_string()),
            ],
            None => Vec::new(),
        }
    }
}

static SECRETS: OnceLock<SessionSecrets> = OnceLock::new();

/// Resolve GIO_SESSION_SECRET once, before the worker is spawned and before
/// any rule set is compiled.
pub fn init(dev_mode: bool) {
    let raw = std::env::var(SECRET_ENV).unwrap_or_default();
    let _ = SECRETS.set(SessionSecrets::resolve(&raw, dev_mode));
}

/// The verification keys, or `None` when no valid secret is configured.
pub fn keys() -> Option<Arc<SessionKeys>> {
    SECRETS.get().and_then(|secrets| secrets.keys.clone())
}

/// Extra environment for the worker: the ephemeral dev secret, if one was
/// generated (a configured secret reaches the worker by inheritance).
pub fn worker_env() -> Vec<(&'static str, String)> {
    SECRETS
        .get()
        .map(SessionSecrets::worker_env)
        .unwrap_or_default()
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn sign_for_tests(secret: &str, cookie_name: &str, exp: u64, payload: &str) -> String {
    let signed = format!("{TOKEN_VERSION}.{exp}.{payload}");
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&derive_mac_key(secret)).expect("hmac key");
    mac.update(format!("{cookie_name}\n{signed}").as_bytes());
    let tag = mac.finalize().into_bytes();
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::new();
    for chunk in tag.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            encoded.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    format!("{signed}.{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Literals produced by packages/giojs-core/src/session.test.ts
    // ("cross-language token vectors") - keep the two in sync.
    const VECTOR_SECRET: &str = "gio-test-vector-secret-a-0123456789abcdef";
    const OTHER_SECRET: &str = "gio-test-vector-secret-b-0123456789abcdef";
    const NOW: u64 = 1_760_000_000;
    const VALID: &str = "v1.4102444800.AAECAwQFBgcICQoLulSFE6juicZYkyz2zL_R94C1c0ZStIFLFSdMJqWsx8KOH636qj_eybdLmR95gANU.pr8iwxUtYILoEPgE-oRgAoi3LwNLjDoZSC0zlskJc5M";
    const EXPIRED: &str = "v1.1700000000.AAECAwQFBgcICQoLulSFE6juicZYkyz2zL_R94C1c0ZStIFLFSdMJqWsx8J6XUCOUuq0m3oD4liTnyEg.OLt5UBtgtgTwmLash43NDFDm_ETiuJCSe5t66dzzFLE";

    fn keys(raw: &str) -> SessionKeys {
        SessionKeys::from_secret_list(raw).expect("valid secrets")
    }

    #[test]
    fn node_vector_verifies() {
        assert!(keys(VECTOR_SECRET).verify("gio_session", VALID, NOW));
    }

    #[test]
    fn node_vector_expired_is_rejected() {
        assert!(!keys(VECTOR_SECRET).verify("gio_session", EXPIRED, NOW));
        // ...but it was authentic: before its exp it verifies.
        assert!(keys(VECTOR_SECRET).verify("gio_session", EXPIRED, 1_699_999_999));
        // Valid up to, not including, exp.
        assert!(!keys(VECTOR_SECRET).verify("gio_session", VALID, 4_102_444_800));
    }

    #[test]
    fn node_vector_tampered_is_rejected() {
        let k = keys(VECTOR_SECRET);
        assert!(!k.verify("gio_session", &VALID.replace("ulSFE6", "ulSFE7"), NOW));
        // Extending the expiry invalidates the MAC.
        assert!(!k.verify(
            "gio_session",
            &VALID.replace("4102444800", "4102444801"),
            NOW
        ));
        assert!(!k.verify("gio_session", &VALID.replace("v1.", "v2."), NOW));
        let mac_flipped = format!("{}A", &VALID[..VALID.len() - 1]);
        assert!(!k.verify("gio_session", &mac_flipped, NOW));
    }

    #[test]
    fn node_vector_wrong_secret_or_cookie_is_rejected() {
        assert!(!keys(OTHER_SECRET).verify("gio_session", VALID, NOW));
        assert!(!keys(VECTOR_SECRET).verify("admin_session", VALID, NOW));
    }

    #[test]
    fn node_vector_verifies_under_a_rotated_secret_list() {
        let rotated = format!("{OTHER_SECRET}, {VECTOR_SECRET}");
        assert!(keys(&rotated).verify("gio_session", VALID, NOW));
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        let k = keys(VECTOR_SECRET);
        let mac = VALID.rsplit_once('.').map(|(_, m)| m).unwrap_or_default();
        for token in [
            "",
            "garbage",
            "....",
            "v1.4102444800.payload",
            &format!("v1.4102444800.payload.{mac}.extra"),
            &format!("v1.04102444800.payload.{mac}"),
            &format!("v1.+4102444800.payload.{mac}"),
            &format!("v1.4102444800..{mac}"),
            &format!("v1.4102444800.pay=load.{mac}"),
            &format!("v1.99999999999999999999.payload.{mac}"),
            &format!("v1.4102444800.{}.{mac}", "A".repeat(5000)),
        ] {
            assert!(!k.verify("gio_session", token, NOW), "{token}");
        }
    }

    #[test]
    fn non_canonical_mac_spellings_are_rejected() {
        let k = keys(VECTOR_SECRET);
        // The last of 43 characters carries two padding bits that must be 0:
        // 'M' (12) has them clear, 'N' (13) sets one.
        assert!(VALID.ends_with('M'));
        let twin = format!("{}N", &VALID[..VALID.len() - 1]);
        assert!(!k.verify("gio_session", &twin, NOW));
        assert_eq!(decode_mac("A"), None);
        assert_eq!(decode_mac(&"A".repeat(44)), None);
        assert_eq!(decode_mac(&format!("{}*", "A".repeat(42))), None);
        assert_eq!(decode_mac(&"A".repeat(43)), Some([0u8; 32]));
    }

    #[test]
    fn test_signer_matches_the_node_format() {
        let token = sign_for_tests(
            VECTOR_SECRET,
            "gio_session",
            4_102_444_800,
            "AAECAwQFBgcICQoLulSFE6juicZYkyz2zL_R94C1c0ZStIFLFSdMJqWsx8KOH636qj_eybdLmR95gANU",
        );
        assert_eq!(token, VALID);
    }

    #[test]
    fn configured_secret_is_used_and_not_re_exported() {
        let secrets = SessionSecrets::resolve(VECTOR_SECRET, true);
        assert!(secrets
            .keys
            .as_ref()
            .is_some_and(|k| k.verify("gio_session", VALID, NOW)));
        // The worker inherits the configured value; nothing extra to send.
        assert!(secrets.worker_env().is_empty());
    }

    #[test]
    fn dev_without_a_secret_shares_an_ephemeral_one_with_the_worker() {
        let secrets = SessionSecrets::resolve(" , ", true);
        let env = secrets.worker_env();
        assert_eq!(env.len(), 2);
        assert_eq!(env[0].0, SECRET_ENV);
        assert_eq!(env[1], (EPHEMERAL_ENV, "1".to_string()));
        let token = sign_for_tests(&env[0].1, "gio_session", NOW + 60, "cGF5bG9hZA");
        assert!(secrets
            .keys
            .as_ref()
            .is_some_and(|k| k.verify("gio_session", &token, NOW)));
        assert_ne!(
            SessionSecrets::resolve("", true).ephemeral_secret,
            secrets.ephemeral_secret
        );
    }

    #[test]
    fn production_without_a_valid_secret_has_no_keys() {
        let rotated_with_short = format!("{VECTOR_SECRET},short");
        for raw in ["", "too-short", rotated_with_short.as_str()] {
            let secrets = SessionSecrets::resolve(raw, false);
            assert!(secrets.keys.is_none(), "{raw}");
            assert!(secrets.worker_env().is_empty(), "{raw}");
        }
        // An invalid configured secret is not silently replaced in dev either.
        assert!(SessionSecrets::resolve("too-short", true).keys.is_none());
    }

    #[test]
    fn secret_list_parsing_matches_session_ts() {
        assert_eq!(
            SessionKeys::from_secret_list("").unwrap_err(),
            SecretError::Empty
        );
        assert_eq!(
            SessionKeys::from_secret_list(" , ,").unwrap_err(),
            SecretError::Empty
        );
        assert_eq!(
            SessionKeys::from_secret_list(&format!("{VECTOR_SECRET},short")).unwrap_err(),
            SecretError::TooShort { index: 2, len: 5 }
        );
        let parsed = keys(&format!(" {VECTOR_SECRET} ,, {OTHER_SECRET} ,"));
        assert_eq!(parsed.mac_keys.len(), 2);
        assert_eq!(format!("{parsed:?}"), "SessionKeys { keys: 2 }");
    }
}
