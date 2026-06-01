//! giojs-css/src/modules.rs
//!
//! CSS Modules class name hashing. Deterministic across builds and platforms.
//! Format: `{localName}_{sha256(filename + localName)[0..5]}`
//! Example: `.button` in `Button.module.css` → `button_3f8a2`

use sha2::{Digest, Sha256};

pub fn hash_class_name(local_name: &str, filename: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(filename.as_bytes());
    hasher.update(local_name.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    format!("{}_{}", local_name, &hex[..5])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_input_always_same_hash() {
        let a = hash_class_name("button", "Button.module.css");
        let b = hash_class_name("button", "Button.module.css");
        assert_eq!(a, b);
    }

    #[test]
    fn different_class_names_produce_different_hashes() {
        let a = hash_class_name("button", "Button.module.css");
        let b = hash_class_name("card", "Button.module.css");
        assert_ne!(a, b);
        assert!(a.starts_with("button_"));
        assert!(b.starts_with("card_"));
    }

    #[test]
    fn different_filenames_produce_different_hashes() {
        let a = hash_class_name("button", "Button.module.css");
        let b = hash_class_name("button", "OtherComponent.module.css");
        assert_ne!(a, b);
    }

    #[test]
    fn hash_suffix_is_five_chars() {
        let result = hash_class_name("wrapper", "Layout.module.css");
        let parts: Vec<&str> = result.splitn(2, '_').collect();
        assert_eq!(parts[0], "wrapper");
        assert_eq!(parts[1].len(), 5);
    }
}
