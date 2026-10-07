//! giojs-server/src/config_check.rs
//!
//! `giojs-server --check-config`: load the .env files and gio.toml exactly as
//! startup does, print one JSON report on stdout and exit - 0 when the server
//! would start with this configuration, 1 when it would refuse - without
//! binding a port or spawning the worker. `gio doctor` reads it to validate
//! the config with the server's own strict parser instead of a second one in
//! JavaScript, and `gio dev` / `gio start` to learn the listen address the
//! environment, the .env files and gio.toml resolve to before printing URLs.
//!
//! The report never carries a value that may be a secret (session secrets,
//! metrics tokens, .env contents) - only whether one is set and valid.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::client_identity::ProxyHeaders;
use crate::config::{self, ConfigError, GioConfig};
use crate::env_files::{EnvFileError, LoadedEnvFiles};
use crate::rules::RuleSet;
use crate::session_token::{self, SessionKeys};

/// The argument that selects this mode; only ever the first one.
pub const FLAG: &str = "--check-config";

/// Whether the process was started as `giojs-server --check-config`.
pub fn requested() -> bool {
    std::env::args_os().nth(1).is_some_and(|arg| arg == FLAG)
}

/// The process inputs the report depends on, gathered once so the report
/// itself is a pure function of them.
struct CheckEnv {
    /// gio.toml as startup would read it, when the file exists.
    config_file: Option<PathBuf>,
    project_root: PathBuf,
    app_dir: PathBuf,
    public_dir: PathBuf,
    cache_dir_env: Option<String>,
    session_secret: String,
}

impl CheckEnv {
    fn from_process() -> Self {
        let project_root = GioConfig::project_root();
        let config_file = Some(GioConfig::path()).filter(|path| path.exists());
        // The same defaults `run` in main.rs applies.
        let app_dir = PathBuf::from(std::env::var("GIO_APP_DIR").unwrap_or_else(|_| "app".into()));
        let public_dir = std::env::var("GIO_PUBLIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| project_root.join("public"));
        CheckEnv {
            config_file,
            project_root,
            app_dir,
            public_dir,
            cache_dir_env: std::env::var("GIO_CACHE_DIR")
                .ok()
                .filter(|dir| !dir.is_empty()),
            session_secret: std::env::var(session_token::SECRET_ENV).unwrap_or_default(),
        }
    }
}

/// Run the check after the .env files were loaded (or failed to): print the
/// report and return the process exit code.
pub fn run(env_files: Result<&LoadedEnvFiles, &EnvFileError>) -> i32 {
    let env = CheckEnv::from_process();
    let report = match env_files {
        Ok(loaded) => report(loaded, GioConfig::try_load(), &env),
        Err(error) => json!({
            "ok": false,
            "errors": [error.to_string()],
            "configFile": env.config_file.as_deref().map(display),
        }),
    };
    println!("{report}");
    if report["ok"] == Value::Bool(true) {
        0
    } else {
        1
    }
}

fn report(
    env_files: &LoadedEnvFiles,
    config: Result<GioConfig, ConfigError>,
    env: &CheckEnv,
) -> Value {
    let base = json!({
        "mode": env_files.mode.as_str(),
        "envFiles": env_files.files,
        "configFile": env.config_file.as_deref().map(display),
    });
    let config = match config {
        Ok(config) => config,
        Err(error) => return with_fields(base, json!({ "ok": false, "errors": [error.to_string()] })),
    };

    let mut errors = Vec::new();
    let cache_dir = config
        .cache
        .disk_dir(&env.project_root, env.cache_dir_env.as_deref());
    if let Err(error) = config::check_cache_dir_placement(&cache_dir, &env.app_dir, &env.public_dir) {
        let source = match env.cache_dir_env {
            Some(_) => "GIO_CACHE_DIR",
            None => "[cache] disk_path",
        };
        errors.push(format!("{source}: {error}"));
    }

    let (session_secret, session_secret_error) =
        if env.session_secret.split(',').all(|secret| secret.trim().is_empty()) {
            ("unset", None)
        } else {
            match SessionKeys::from_secret_list(&env.session_secret) {
                Ok(_) => ("valid", None),
                Err(error) => ("invalid", Some(error.to_string())),
            }
        };

    with_fields(
        base,
        json!({
            "ok": errors.is_empty(),
            "errors": errors,
            "warnings": RuleSet::skipped_rules(&config.middleware_rules()),
            "listen": {
                "host": config.server.host,
                "port": config.server.port,
                "portSource": config.port_source,
                "tls": config.server.tls.enabled,
            },
            "trustedProxies": config.server.trusted_proxies.len(),
            "proxyHeaders": match config.server.proxy_headers {
                ProxyHeaders::XForwarded => "x-forwarded",
                ProxyHeaders::Forwarded => "forwarded",
            },
            "rateLimitRules": config.rate_limits.len(),
            "sessionGuards": config.guards.iter().filter(|guard| guard.require_session).count(),
            "sessionSecret": session_secret,
            "sessionSecretError": session_secret_error,
            "cacheDir": display(&absolute(&cache_dir)),
        }),
    )
}

fn with_fields(mut base: Value, fields: Value) -> Value {
    if let (Some(base), Value::Object(fields)) = (base.as_object_mut(), fields) {
        base.extend(fields);
    }
    base
}

/// Relative paths resolve against the CWD, like every path the server opens
/// (`./` segments dropped: the project root is often just `.`).
fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    joined
        .components()
        .filter(|component| *component != std::path::Component::CurDir)
        .collect()
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env_files::EnvMode;

    fn env_in(root: &Path) -> CheckEnv {
        CheckEnv {
            config_file: Some(root.join("gio.toml")),
            project_root: root.to_path_buf(),
            app_dir: root.join("app"),
            public_dir: root.join("public"),
            cache_dir_env: None,
            session_secret: String::new(),
        }
    }

    fn loaded(files: &[&str]) -> LoadedEnvFiles {
        LoadedEnvFiles {
            mode: EnvMode::Production,
            files: files.iter().map(|file| file.to_string()).collect(),
            skipped: Vec::new(),
            ignored_node_env: false,
        }
    }

    fn parse(raw: &str) -> Result<GioConfig, ConfigError> {
        GioConfig::parse(raw, "gio.toml")
    }

    /// A project root that is never created: the report only compares paths.
    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("gio_config_check_test_{}", std::process::id()))
    }

    #[test]
    fn valid_config_reports_listen_address_and_counts() {
        let root = test_root();
        let config = parse(
            "[server]\nport = 8080\nhost = \"127.0.0.1\"\ntrusted_proxies = [\"10.0.0.0/8\"]\n\n\
             [[rate_limits]]\npath = \"/api/*rest\"\nper_ip = 10\nwindow_seconds = 60\n\n\
             [[guards]]\npath = \"/admin/*rest\"\nrequire_session = true\nredirect_to = \"/login\"\n",
        );
        let report = report(&loaded(&[".env"]), config, &env_in(&root));
        assert_eq!(report["ok"], true, "{report}");
        assert_eq!(report["mode"], "production");
        assert_eq!(report["envFiles"], json!([".env"]));
        assert_eq!(report["listen"]["host"], "127.0.0.1");
        assert_eq!(report["listen"]["port"], 8080);
        assert_eq!(report["listen"]["portSource"], "gio.toml");
        assert_eq!(report["listen"]["tls"], false);
        assert_eq!(report["trustedProxies"], 1);
        assert_eq!(report["proxyHeaders"], "x-forwarded");
        assert_eq!(report["rateLimitRules"], 1);
        assert_eq!(report["sessionGuards"], 1);
        assert_eq!(report["sessionSecret"], "unset");
        assert_eq!(report["warnings"], json!([]));
        let cache_dir = report["cacheDir"].as_str().unwrap();
        assert!(cache_dir.starts_with(&root.display().to_string()), "{cache_dir}");
    }

    #[test]
    fn config_errors_fail_the_check_with_the_startup_message() {
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse("[server]\nprot = 3000\n"),
            &env_in(&root),
        );
        assert_eq!(report["ok"], false);
        let error = report["errors"][0].as_str().unwrap();
        assert!(error.contains("server.prot"), "{error}");
        assert!(error.contains("server.port"), "the did-you-mean survives: {error}");
        assert!(report.get("listen").is_none());
    }

    #[test]
    fn cache_dir_inside_public_fails_the_check() {
        let root = test_root();
        let mut env = env_in(&root);
        env.cache_dir_env = Some(root.join("public/cache").display().to_string());
        let report = report(&loaded(&[]), parse(""), &env);
        assert_eq!(report["ok"], false);
        let error = report["errors"][0].as_str().unwrap();
        assert!(error.starts_with("GIO_CACHE_DIR: "), "{error}");
    }

    #[test]
    fn session_secret_is_reported_by_status_never_by_value() {
        let root = test_root();
        let mut env = env_in(&root);
        env.session_secret = "too-short-secret".into();
        let report_value = report(&loaded(&[]), parse(""), &env);
        assert_eq!(report_value["sessionSecret"], "invalid");
        assert!(!report_value.to_string().contains("too-short-secret"));

        env.session_secret = "a".repeat(32);
        let report_value = report(&loaded(&[]), parse(""), &env);
        assert_eq!(report_value["sessionSecret"], "valid");
        assert!(!report_value.to_string().contains(&"a".repeat(32)));
    }

    #[test]
    fn rules_the_server_would_skip_are_warnings() {
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse("[[redirects]]\nfrom = \"/old\"\nto = \"/new\"\nstatus = 200\n"),
            &env_in(&root),
        );
        assert_eq!(report["ok"], true, "a skipped rule does not stop startup");
        let warning = report["warnings"][0].as_str().unwrap();
        assert!(warning.starts_with("[[redirects]] /old: "), "{warning}");
    }
}
