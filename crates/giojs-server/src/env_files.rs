//! giojs-server/src/env_files.rs
//!
//! `.env` file loading. Runs first thing at startup - before gio.toml is
//! parsed and before the Node worker is spawned - so the server config and
//! the worker (which inherits the process environment) see the same values.
//!
//! Files come from the project root in Next.js precedence order, first
//! definition wins: `.env.{mode}.local`, `.env.local`, `.env.{mode}`, `.env`,
//! where mode is `development` when NODE_ENV=development and `production`
//! otherwise (the same rule that switches dev mode on). Variables already in
//! the process environment are never overridden, so real deploy-time env
//! always beats a file. Syntax (quotes, multiline values, `export` prefix,
//! comments, `${VAR}` substitution) is dotenvy's; packages/giojs-core's
//! env-files.ts mirrors it for `gio export` and standalone builds. Only file
//! names are ever logged, never values. A candidate that is not a regular
//! file (`python -m venv .env` makes a `.env/` directory) is skipped.

use std::cell::Cell;
use std::fmt;
use std::io::{self, Read};
use std::path::Path;

/// Which `.env.{mode}*` files apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvMode {
    Development,
    Production,
}

impl EnvMode {
    pub fn from_node_env(node_env: Option<&str>) -> Self {
        if node_env == Some("development") {
            EnvMode::Development
        } else {
            EnvMode::Production
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EnvMode::Development => "development",
            EnvMode::Production => "production",
        }
    }
}

/// Candidate file names, highest precedence first.
pub fn candidate_files(mode: EnvMode) -> [String; 4] {
    let mode = mode.as_str();
    [
        format!(".env.{mode}.local"),
        ".env.local".to_string(),
        format!(".env.{mode}"),
        ".env".to_string(),
    ]
}

/// What a load applied, for the startup log line.
#[derive(Debug, PartialEq, Eq)]
pub struct LoadedEnvFiles {
    pub mode: EnvMode,
    /// File names actually read, in precedence order.
    pub files: Vec<String>,
    /// Candidates that exist but are not regular files, skipped unread.
    pub skipped: Vec<String>,
    /// A file tried to set NODE_ENV. Mode was already decided from the real
    /// environment, so honoring it would mix one mode's files with another
    /// mode's server behavior.
    pub ignored_node_env: bool,
}

/// A file that exists but cannot be read or parsed. Carries a line number,
/// never the line itself: the line holds a value, and values are secrets.
#[derive(Debug)]
pub struct EnvFileError {
    pub file: String,
    pub reason: String,
}

impl fmt::Display for EnvFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "cannot load {}: {}", self.file, self.reason)
    }
}

impl std::error::Error for EnvFileError {}

/// Where loaded variables go. The process environment in production; a map
/// in tests, which keeps them from racing on the shared process env.
pub trait EnvTarget {
    fn is_set(&self, key: &str) -> bool;
    fn set(&mut self, key: &str, value: &str);
}

pub struct ProcessEnv;

impl EnvTarget for ProcessEnv {
    fn is_set(&self, key: &str) -> bool {
        std::env::var_os(key).is_some()
    }

    fn set(&mut self, key: &str, value: &str) {
        std::env::set_var(key, value);
    }
}

/// Load the env files for `mode` from `root` into `target`.
pub fn load(
    root: &Path,
    mode: EnvMode,
    target: &mut dyn EnvTarget,
) -> Result<LoadedEnvFiles, EnvFileError> {
    let mut loaded = LoadedEnvFiles {
        mode,
        files: Vec::new(),
        skipped: Vec::new(),
        ignored_node_env: false,
    };
    for name in candidate_files(mode) {
        let path = root.join(&name);
        let read = std::fs::metadata(&path).and_then(|meta| {
            if meta.is_file() {
                std::fs::read_to_string(&path).map(Some)
            } else {
                Ok(None)
            }
        });
        let contents = match read {
            Ok(Some(contents)) => contents,
            Ok(None) => {
                loaded.skipped.push(name);
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(EnvFileError {
                    file: name,
                    reason: error.to_string(),
                })
            }
        };
        let source = contents.strip_prefix('\u{feff}').unwrap_or(&contents);
        let vars = parse(source).map_err(|reason| EnvFileError {
            reason,
            file: name.clone(),
        })?;
        // Set per file (not after all files): a later, lower-precedence file
        // can then substitute `${VAR}` from a higher one.
        for (key, value) in vars {
            if key == "NODE_ENV" {
                loaded.ignored_node_env = true;
            } else if !target.is_set(&key) {
                target.set(&key, &value);
            }
        }
        loaded.files.push(name);
    }
    Ok(loaded)
}

/// Startup entry point: the project root config.rs uses, mode from NODE_ENV.
pub fn load_for_startup() -> Result<LoadedEnvFiles, EnvFileError> {
    let root = crate::config::GioConfig::project_root();
    let mode = EnvMode::from_node_env(std::env::var("NODE_ENV").ok().as_deref());
    load(&root, mode, &mut ProcessEnv)
}

/// Hands dotenvy one byte per read, so the BufReader inside its iterator
/// never reads ahead: `consumed` is always the end of the logical line the
/// parser last returned.
struct OneByteReader<'a> {
    bytes: &'a [u8],
    consumed: &'a Cell<usize>,
}

impl Read for OneByteReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let at = self.consumed.get();
        match (self.bytes.get(at), buf.first_mut()) {
            (Some(&byte), Some(slot)) => {
                *slot = byte;
                self.consumed.set(at + 1);
                Ok(1)
            }
            _ => Ok(0),
        }
    }
}

/// Parse with dotenvy. An error is reported as a line number, never the
/// line itself: the line holds a value, and values are secrets.
fn parse(source: &str) -> Result<Vec<(String, String)>, String> {
    let consumed = Cell::new(0);
    let reader = OneByteReader {
        bytes: source.as_bytes(),
        consumed: &consumed,
    };
    let mut vars = Vec::new();
    let mut parsed_up_to = 0;
    for item in dotenvy::from_read_iter(reader) {
        match item {
            Ok(var) => {
                vars.push(var);
                parsed_up_to = consumed.get();
            }
            Err(dotenvy::Error::LineParse(..)) => {
                return Err(format!(
                    "invalid syntax on line {}",
                    failing_line(source, parsed_up_to)
                ))
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(vars)
}

/// 1-based line the failing logical line starts on: the first line after
/// the last parsed variable that dotenvy does not skip as blank or a
/// comment. (The error itself carries only the offending text - for a bad
/// value, just the value - which can also appear earlier in the file.)
fn failing_line(source: &str, parsed_up_to: usize) -> usize {
    let mut start = parsed_up_to;
    for line in source[parsed_up_to..].split_inclusive('\n') {
        let text = line.trim_start();
        if !text.is_empty() && !text.starts_with('#') {
            break;
        }
        start += line.len();
    }
    source[..start].matches('\n').count() + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[derive(Default)]
    struct MapEnv(HashMap<String, String>);

    impl EnvTarget for MapEnv {
        fn is_set(&self, key: &str) -> bool {
            self.0.contains_key(key)
        }

        fn set(&mut self, key: &str, value: &str) {
            self.0.insert(key.to_string(), value.to_string());
        }
    }

    fn project_with(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("gio_env_files_test_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for (file, contents) in files {
            std::fs::write(root.join(file), contents).unwrap();
        }
        root
    }

    fn get<'a>(env: &'a MapEnv, key: &str) -> Option<&'a str> {
        env.0.get(key).map(String::as_str)
    }

    #[test]
    fn mode_follows_the_dev_mode_rule() {
        assert_eq!(
            EnvMode::from_node_env(Some("development")),
            EnvMode::Development
        );
        assert_eq!(
            EnvMode::from_node_env(Some("production")),
            EnvMode::Production
        );
        assert_eq!(EnvMode::from_node_env(Some("test")), EnvMode::Production);
        assert_eq!(EnvMode::from_node_env(None), EnvMode::Production);
    }

    #[test]
    fn candidate_files_are_in_next_precedence_order() {
        assert_eq!(
            candidate_files(EnvMode::Development),
            [
                ".env.development.local",
                ".env.local",
                ".env.development",
                ".env"
            ]
        );
    }

    #[test]
    fn first_file_in_precedence_order_wins() {
        let root = project_with(
            "precedence",
            &[
                (".env", "A=env\nB=env\nC=env\nD=env\n"),
                (".env.production", "A=prod\nB=prod\nC=prod\n"),
                (".env.local", "A=local\nB=local\n"),
                (".env.production.local", "A=prod-local\n"),
                (".env.development", "A=dev\nDEV_ONLY=1\n"),
            ],
        );
        let mut env = MapEnv::default();
        let loaded = load(&root, EnvMode::Production, &mut env).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(get(&env, "A"), Some("prod-local"));
        assert_eq!(get(&env, "B"), Some("local"));
        assert_eq!(get(&env, "C"), Some("prod"));
        assert_eq!(get(&env, "D"), Some("env"));
        assert_eq!(get(&env, "DEV_ONLY"), None, "other mode's files never load");
        assert_eq!(
            loaded.files,
            [
                ".env.production.local",
                ".env.local",
                ".env.production",
                ".env"
            ]
        );
        assert_eq!(loaded.mode, EnvMode::Production);
    }

    #[test]
    fn existing_variables_are_never_overridden() {
        let root = project_with("no_override", &[(".env", "TOKEN=from-file\nOTHER=x\n")]);
        let mut env = MapEnv::default();
        env.set("TOKEN", "from-process");
        let result = load(&root, EnvMode::Development, &mut env);
        let _ = std::fs::remove_dir_all(&root);
        result.unwrap();
        assert_eq!(get(&env, "TOKEN"), Some("from-process"));
        assert_eq!(get(&env, "OTHER"), Some("x"));
    }

    #[test]
    fn missing_files_load_nothing() {
        let root = project_with("empty", &[]);
        let mut env = MapEnv::default();
        let loaded = load(&root, EnvMode::Production, &mut env).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert!(loaded.files.is_empty());
        assert!(env.0.is_empty());
    }

    #[test]
    fn dotenv_syntax_is_supported() {
        let root = project_with(
            "syntax",
            &[(
                ".env",
                concat!(
                    "\u{feff}# comment\nexport EXPORTED=yes\nSINGLE='a $b'\n",
                    "DOUBLE=\"line1\\nline2\"\nMULTI=\"one\ntwo\"\n",
                    "INLINE=value # trailing comment\nEMPTY=\nDUP=first\nDUP=second\n",
                    "export=as-key\nSPACED  =  \"x y\"\nCRLF=windows\r\n",
                    "GIOTESTBASE=/srv\nBRACED=${GIOTESTBASE}/app\nBARE=$GIOTESTBASE\n",
                    "ESCAPED=\\$GIOTESTBASE\nQUOTED=\"$GIOTESTBASE/q\"\n",
                ),
            )],
        );
        let mut env = MapEnv::default();
        let result = load(&root, EnvMode::Production, &mut env);
        let _ = std::fs::remove_dir_all(&root);
        result.unwrap();
        assert_eq!(get(&env, "EXPORTED"), Some("yes"));
        assert_eq!(get(&env, "SINGLE"), Some("a $b"));
        assert_eq!(get(&env, "DOUBLE"), Some("line1\nline2"));
        assert_eq!(get(&env, "MULTI"), Some("one\ntwo"));
        assert_eq!(get(&env, "INLINE"), Some("value"));
        assert_eq!(get(&env, "EMPTY"), Some(""));
        assert_eq!(get(&env, "DUP"), Some("first"));
        assert_eq!(get(&env, "export"), Some("as-key"));
        assert_eq!(get(&env, "SPACED"), Some("x y"));
        assert_eq!(get(&env, "CRLF"), Some("windows"));
        assert_eq!(get(&env, "BRACED"), Some("/srv/app"));
        assert_eq!(get(&env, "BARE"), Some("/srv"));
        assert_eq!(get(&env, "ESCAPED"), Some("$GIOTESTBASE"));
        assert_eq!(get(&env, "QUOTED"), Some("/srv/q"));
    }

    #[test]
    fn node_env_in_a_file_is_ignored_and_reported() {
        let root = project_with("node_env", &[(".env", "NODE_ENV=development\nX=1\n")]);
        let mut env = MapEnv::default();
        let loaded = load(&root, EnvMode::Production, &mut env).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert!(loaded.ignored_node_env);
        assert_eq!(get(&env, "NODE_ENV"), None);
        assert_eq!(get(&env, "X"), Some("1"));
    }

    #[test]
    fn parse_errors_name_the_file_and_line_but_not_the_value() {
        let root = project_with(
            "bad",
            &[(".env.local", "OK=1\n\nSECRET=\"hunter2-unterminated\n")],
        );
        let mut env = MapEnv::default();
        let error = load(&root, EnvMode::Production, &mut env).unwrap_err();
        let _ = std::fs::remove_dir_all(&root);
        let message = error.to_string();
        assert!(message.contains(".env.local"), "{message}");
        assert!(message.contains("line 3"), "{message}");
        assert!(!message.contains("hunter2"), "{message}");
    }

    fn parse_error_line(source: &str) -> String {
        parse(source).unwrap_err()
    }

    #[test]
    fn parse_errors_point_at_the_failing_line_not_an_earlier_lookalike() {
        // dotenvy reports only the bad value ("x y"), which line 1 also holds.
        assert_eq!(
            parse_error_line("NOTE=\"x y\"\nB=x y\n"),
            "invalid syntax on line 2"
        );
        // Blank and comment lines (even ones containing the text) are skipped.
        assert_eq!(
            parse_error_line("A=1\n\n# x y\n   \nB=x y\n"),
            "invalid syntax on line 5"
        );
        // A multi-line value before the error counts all of its lines.
        assert_eq!(
            parse_error_line("MULTI=\"one\ntwo\"\nB=x y\n"),
            "invalid syntax on line 3"
        );
        // An unterminated quote names the line the value starts on.
        assert_eq!(
            parse_error_line("A=1\nS=\"a\nb\n"),
            "invalid syntax on line 2"
        );
        assert_eq!(parse_error_line("1BAD=x\n"), "invalid syntax on line 1");
        assert_eq!(
            parse("A=1 # c\nB=\"x\ny\"\n").unwrap(),
            [
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "x\ny".to_string())
            ]
        );
    }

    #[test]
    fn candidates_that_are_not_files_are_skipped() {
        // `python -m venv .env` leaves a directory where the file would be.
        let root = project_with("venv_dir", &[(".env.local", "FROM_LOCAL=1\n")]);
        std::fs::create_dir_all(root.join(".env").join("bin")).unwrap();
        let mut env = MapEnv::default();
        let result = load(&root, EnvMode::Production, &mut env);
        let _ = std::fs::remove_dir_all(&root);
        let loaded = result.unwrap();
        assert_eq!(loaded.files, [".env.local"]);
        assert_eq!(loaded.skipped, [".env"]);
        assert_eq!(get(&env, "FROM_LOCAL"), Some("1"));
    }
}
