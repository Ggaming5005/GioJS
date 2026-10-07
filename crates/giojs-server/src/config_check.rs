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
//! Startup and the check share `validate`: every refusal startup makes after
//! gio.toml parses ([cache] placement, [security], the revalidation token,
//! local [[fonts]] files, TLS) lives there once, so the check cannot say yes
//! to a configuration the
//! server refuses.
//!
//! The report never carries a value that may be a secret (session secrets,
//! metrics and revalidation tokens, .env contents) - only whether one is set
//! and valid. Config errors name a key or a position, never a quoted line.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::client_identity::ProxyHeaders;
use crate::config::{self, ConfigError, GioConfig};
use crate::env_files::{EnvFileError, LoadedEnvFiles};
use crate::revalidate;
use crate::rules::RuleSet;
use crate::security::SecurityPolicy;
use crate::session_token::{self, SessionKeys};

/// The argument that selects this mode; only ever the first one.
pub const FLAG: &str = "--check-config";

/// Whether the process was started as `giojs-server --check-config`.
pub fn requested() -> bool {
    std::env::args_os().nth(1).is_some_and(|arg| arg == FLAG)
}

/// The process environment startup checks gio.toml against: where the app,
/// public/ and the page cache live, and the revalidation token override.
pub struct StartupEnv {
    pub project_root: PathBuf,
    pub app_dir: String,
    pub public_dir: PathBuf,
    /// GIO_CACHE_DIR, when set and non-empty.
    pub cache_dir_env: Option<String>,
    /// GIO_REVALIDATE_TOKEN, as set (resolve_token ignores an empty one).
    pub revalidate_token_env: Option<String>,
}

impl StartupEnv {
    pub fn from_process() -> Self {
        let project_root = GioConfig::project_root();
        // public/ sits next to app/ like gio.toml does, so a server started
        // from another directory (GIO_APP_DIR=path/to/app) still finds it.
        let public_dir = std::env::var("GIO_PUBLIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| project_root.join("public"));
        StartupEnv {
            app_dir: std::env::var("GIO_APP_DIR").unwrap_or_else(|_| "app".to_string()),
            public_dir,
            cache_dir_env: std::env::var("GIO_CACHE_DIR")
                .ok()
                .filter(|dir| !dir.is_empty()),
            revalidate_token_env: std::env::var(revalidate::TOKEN_ENV).ok(),
            project_root,
        }
    }
}

/// What startup builds from a configuration `validate` accepted.
pub struct Validated {
    /// The page cache directory (not created yet).
    pub cache_dir: PathBuf,
    /// [security], compiled; the nonce placeholder is installed later.
    pub security: SecurityPolicy,
    /// The revalidation endpoint's token; None leaves the endpoint off.
    pub revalidate_token: Option<String>,
    /// Present when [server.tls] is enabled.
    pub tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
}

/// Every check startup makes on a parsed gio.toml before it creates a
/// directory, spawns the worker or binds: the page cache directory's
/// placement, [security] (headers, CSP, CSRF origins and exemptions), the
/// revalidation token (GIO_REVALIDATE_TOKEN or [revalidate] token), the
/// local `[[fonts]]` files and the TLS certificate and key. Errors are the
/// messages startup prints after
/// "configuration error:", all of them rather than the first.
pub fn validate(config: &GioConfig, env: &StartupEnv) -> Result<Validated, Vec<String>> {
    let mut errors = Vec::new();

    let cache_dir = config
        .cache
        .disk_dir(&env.project_root, env.cache_dir_env.as_deref());
    // A directory inside public/ must not even appear.
    if let Err(error) =
        config::check_cache_dir_placement(&cache_dir, Path::new(&env.app_dir), &env.public_dir)
    {
        let source = match env.cache_dir_env {
            Some(_) => "GIO_CACHE_DIR",
            None => "[cache] disk_path",
        };
        errors.push(format!("{source}: {error}"));
    }

    let security = SecurityPolicy::new(&config.security, config.server.tls.enabled)
        .map_err(|error| errors.push(error.to_string()))
        .ok();

    let revalidate_token = revalidate::resolve_token(
        env.revalidate_token_env.as_deref(),
        &config.revalidate.token,
    )
    .map_err(|error| errors.push(error.to_string()))
    .ok();

    errors.extend(local_font_errors(config, &env.public_dir));

    let tls_acceptor = if config.server.tls.enabled {
        crate::load_tls_acceptor(&config.server.tls, config.server.http2)
            .map(Some)
            .map_err(|error| errors.push(format!("{error:#}")))
            .ok()
    } else {
        Some(None)
    };

    match (security, revalidate_token, tls_acceptor) {
        (Some(security), Some(revalidate_token), Some(tls_acceptor)) if errors.is_empty() => {
            Ok(Validated {
                cache_dir,
                security,
                revalidate_token,
                tls_acceptor,
            })
        }
        _ => Err(errors),
    }
}

/// One line per protection gio.toml turns off or loosens, naming the key:
/// startup logs each at warn level and `--check-config` reports them under
/// `warnings`, so the two always say the same thing. Settings that only
/// apply in dev mode are included in every mode - the file is the same.
pub fn protections_off_warnings(config: &GioConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    let security = &config.security;
    if !security.csrf.enabled {
        warnings.push(
            "[security.csrf] enabled = false: any website can send form posts and other unsafe \
             requests to this server with your visitors' cookies - prefer listing origins in \
             [security.csrf] trusted_origins, or public endpoints in [security.csrf] exempt"
                .to_string(),
        );
    }
    if !security.websocket.check_origin {
        warnings.push(
            "[security.websocket] check_origin = false: any website can open WebSockets to this \
             server with your visitors' cookies - prefer listing origins in [security.csrf] \
             trusted_origins, or public endpoints in [security.csrf] exempt"
                .to_string(),
        );
    }
    if !security.default_headers {
        warnings.push(
            "[security] default_headers = false: responses no longer carry \
             x-content-type-options, x-frame-options or referrer-policy (MIME sniffing, \
             clickjacking and full-URL referrers are back) unless [security.headers] sets them"
                .to_string(),
        );
    }
    if crate::dev_guard::allows_any_host(&config.dev.allowed_hosts) {
        warnings.push(
            "[dev] allowed_hosts = [\"*\"]: in dev mode the /_gio/devtools endpoints (source \
             codeframes, live server state) and render error details answer any Host from any \
             machine, so DNS rebinding is no longer blocked - list the hostnames you browse from \
             instead"
                .to_string(),
        );
    }
    let server = &config.server;
    if server.max_body_bytes == 0 {
        warnings.push(format!(
            "[server] max_body_bytes = 0: request bodies have no limit of their own - each is \
             buffered in memory up to the worker's {} MiB message cap",
            crate::ipc::MAX_IPC_MESSAGE_SIZE / (1024 * 1024)
        ));
    } else if server.max_body_bytes > crate::ipc::MAX_BINARY_BODY_BYTES {
        warnings.push(format!(
            "[server] max_body_bytes = {} is more than a worker message can carry: binary \
             bodies above {} MiB (base64-encoded to the {} MiB message cap) still get a 413",
            server.max_body_bytes,
            crate::ipc::MAX_BINARY_BODY_BYTES / (1024 * 1024),
            crate::ipc::MAX_IPC_MESSAGE_SIZE / (1024 * 1024)
        ));
    }
    if server.max_connections == 0 {
        warnings.push(
            "[server] max_connections = 0: concurrent connections are unlimited - a connection \
             flood can exhaust file descriptors and memory"
                .to_string(),
        );
    }
    let metrics = &config.metrics;
    if let Some(everything) = metrics
        .ip_allowlist
        .entries()
        .iter()
        .find(|net| net.is_everything())
        .filter(|_| metrics.enabled && metrics.token.is_empty())
    {
        warnings.push(format!(
            "[metrics] ip_allowlist includes {everything} and no token is set: /_gio/metrics is \
             open to every client of that family - set [metrics] token, or list only your \
             scrapers' addresses"
        ));
    }
    if let Some(everything) = server
        .trusted_proxies
        .entries()
        .iter()
        .find(|net| net.is_everything())
    {
        warnings.push(format!(
            "[server] trusted_proxies includes {everything}: any client of that family can pick \
             its own IP, rate-limit bucket and request id - list only your proxies' addresses"
        ));
    }
    if !server.skew_protection {
        warnings.push(
            "[server] skew_protection = false: a browser still running an older deployment's \
             code keeps navigating without a reload, against pages and actions that may no \
             longer match it"
                .to_string(),
        );
    }
    let images = &config.images;
    if images.enabled {
        for (key, zero, risk) in [
            (
                "max_remote_bytes",
                images.max_remote_bytes == 0,
                "remote sources of any size are downloaded into memory",
            ),
            (
                "remote_timeout_secs",
                images.remote_timeout_secs == 0,
                "a slow remote source holds its request open indefinitely",
            ),
            (
                "max_source_dimension",
                images.max_source_dimension == 0,
                "a small file declaring huge dimensions can exhaust memory and CPU",
            ),
            (
                "max_decode_bytes",
                images.max_decode_bytes == 0,
                "decoding one source may allocate any amount of memory",
            ),
        ] {
            if zero {
                warnings.push(format!("[images] {key} = 0: {risk}"));
            }
        }
    }
    if config.server.render_timeout_secs == 0 {
        warnings.push(
            "[server] render_timeout_secs = 0: a render that never answers holds its \
             connection and a worker slot indefinitely"
                .to_string(),
        );
    }
    if !config.rate_limits.is_empty() && config.server.rate_limit_max_buckets == 0 {
        warnings.push(
            "[server] rate_limit_max_buckets = 0: rate-limit buckets are never evicted - \
             clients rotating addresses grow memory without bound"
                .to_string(),
        );
    }
    for rule in &config.rate_limits {
        if rule.key_header.is_some() && rule.max_keys_per_client == 0 {
            warnings.push(format!(
                "[[rate_limits]] {}: max_keys_per_client = 0 - one client can mint a fresh \
                 budget for every key_header value it sends",
                rule.path
            ));
        }
    }
    if config.websocket.enabled && config.websocket.max_connections == 0 {
        warnings.push(
            "[websocket] max_connections = 0: WebSocket connections are unlimited - every \
             open socket holds memory and a file descriptor"
                .to_string(),
        );
    }
    warnings
}

/// `[dev] allowed_hosts` entries dev startup ignores, one warning each.
pub fn invalid_allowed_hosts_warnings(config: &GioConfig) -> Vec<String> {
    crate::dev_guard::DevHostPolicy::new(&config.server.host, &config.dev.allowed_hosts)
        .invalid_allowed_hosts()
        .iter()
        .map(|entry| {
            format!(
                "ignoring [dev] allowed_hosts entry {entry:?} in gio.toml: expected a hostname \
                 or IP such as \"myvm.local\", \"192.168.1.20\" or \"*.tunnel.example\", or \
                 \"*\" for any host"
            )
        })
        .collect()
}

/// The `[[fonts]]` entries naming a file under public/ that startup could not
/// copy: an invalid path, or a file that is missing or unreadable. Checked
/// before the worker spawns, so a deploy that lost its font files fails here
/// (and in `--check-config`) instead of after the build. Remote fonts are
/// downloaded at startup and not checked.
fn local_font_errors(config: &GioConfig, public_dir: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    for font in config.fonts.iter().filter(|font| !font.url.contains("://")) {
        let path = match giojs_font::local_font_path(&font.url, public_dir) {
            Ok(path) => path,
            Err(error) => {
                errors.push(format!("[[fonts]] {}: {error}", font.family));
                continue;
            }
        };
        let problem = match std::fs::metadata(&path) {
            Err(_) => Some("not found".to_string()),
            Ok(meta) if !meta.is_file() => Some("is not a file".to_string()),
            Ok(_) => std::fs::File::open(&path)
                .err()
                .map(|error| format!("cannot be read ({error})")),
        };
        if let Some(problem) = problem {
            errors.push(format!(
                "[[fonts]] {}: {} {problem} (url = \"{}\")",
                font.family,
                path.display(),
                font.url
            ));
        }
    }
    errors
}

/// The process inputs the report depends on, gathered once so the report
/// itself is a pure function of them.
struct CheckEnv {
    /// gio.toml as startup would read it, when the file exists.
    config_file: Option<PathBuf>,
    startup: StartupEnv,
    session_secret: String,
}

impl CheckEnv {
    fn from_process() -> Self {
        CheckEnv {
            config_file: Some(GioConfig::path()).filter(|path| path.exists()),
            startup: StartupEnv::from_process(),
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
        // `GIO_ENV_FILES` or `[env] files` when loading is off, else null.
        "envFilesDisabledBy": env_files.disabled_by,
        "configFile": env.config_file.as_deref().map(display),
    });
    let config = match config {
        Ok(config) => config,
        Err(error) => return with_fields(base, json!({ "ok": false, "errors": [error.to_string()] })),
    };

    let errors = validate(&config, &env.startup).err().unwrap_or_default();
    let cache_dir = config
        .cache
        .disk_dir(&env.startup.project_root, env.startup.cache_dir_env.as_deref());

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
            "warnings": warnings(&config),
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

/// Everything startup would warn about in this configuration: loosened
/// protections, ignored `[dev] allowed_hosts` entries, skipped rules.
fn warnings(config: &GioConfig) -> Vec<String> {
    let mut warnings = protections_off_warnings(config);
    warnings.extend(invalid_allowed_hosts_warnings(config));
    warnings.extend(RuleSet::skipped_rules(&config.middleware_rules()));
    warnings
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
            startup: StartupEnv {
                project_root: root.to_path_buf(),
                app_dir: root.join("app").display().to_string(),
                public_dir: root.join("public"),
                cache_dir_env: None,
                revalidate_token_env: None,
            },
            session_secret: String::new(),
        }
    }

    fn loaded(files: &[&str]) -> LoadedEnvFiles {
        LoadedEnvFiles {
            mode: EnvMode::Production,
            files: files.iter().map(|file| file.to_string()).collect(),
            skipped: Vec::new(),
            ignored_node_env: false,
            disabled_by: None,
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
        env.startup.cache_dir_env = Some(root.join("public/cache").display().to_string());
        let report = report(&loaded(&[]), parse(""), &env);
        assert_eq!(report["ok"], false);
        let error = report["errors"][0].as_str().unwrap();
        assert!(error.starts_with("GIO_CACHE_DIR: "), "{error}");
    }

    #[test]
    fn security_settings_startup_refuses_fail_the_check() {
        let root = test_root();
        for (toml, expected) in [
            (
                "[security.csrf]\ntrusted_origins = [\"admin.example.com\"]\n",
                "[security.csrf] trusted_origins entry \"admin.example.com\"",
            ),
            (
                "[security.csrf]\nexempt = [\"api/webhooks\"]\n",
                "[security.csrf] exempt entry \"api/webhooks\"",
            ),
            (
                "[security.headers]\n\"bad header\" = \"x\"\n",
                "[security.headers] \"bad header\" is not a valid header name",
            ),
        ] {
            let report = report(&loaded(&[]), parse(toml), &env_in(&root));
            assert_eq!(report["ok"], false, "{toml}: {report}");
            let error = report["errors"][0].as_str().unwrap();
            assert!(error.starts_with(expected), "{toml}: {error}");
            assert!(report["listen"].is_object(), "the rest of the report is still there");
        }
    }

    #[test]
    fn a_short_revalidation_token_fails_the_check_without_its_value() {
        let root = test_root();
        let report_value = report(
            &loaded(&[]),
            parse("[revalidate]\ntoken = \"short-token\"\n"),
            &env_in(&root),
        );
        assert_eq!(report_value["ok"], false);
        let error = report_value["errors"][0].as_str().unwrap();
        assert!(error.contains("[revalidate] token) is 11 bytes"), "{error}");
        assert!(!report_value.to_string().contains("short-token"));

        // GIO_REVALIDATE_TOKEN outranks gio.toml, as at startup.
        let mut env = env_in(&root);
        env.startup.revalidate_token_env = Some("tiny".into());
        let report_value = report(&loaded(&[]), parse(""), &env);
        let error = report_value["errors"][0].as_str().unwrap();
        assert!(error.contains("GIO_REVALIDATE_TOKEN) is 4 bytes"), "{error}");
        env.startup.revalidate_token_env = Some("t".repeat(32));
        assert_eq!(report(&loaded(&[]), parse(""), &env)["ok"], true);
    }

    #[test]
    fn tls_without_a_certificate_fails_the_check() {
        let root = test_root();
        let no_cert = report(
            &loaded(&[]),
            parse("[server.tls]\nenabled = true\n"),
            &env_in(&root),
        );
        assert_eq!(no_cert["ok"], false);
        let error = no_cert["errors"][0].as_str().unwrap();
        assert_eq!(error, "TLS enabled but cert_path not set in gio.toml");

        let missing_files = report(
            &loaded(&[]),
            parse(
                "[server.tls]\nenabled = true\ncert_path = \"/nonexistent/cert.pem\"\n\
                 key_path = \"/nonexistent/key.pem\"\n",
            ),
            &env_in(&root),
        );
        let error = missing_files["errors"][0].as_str().unwrap();
        assert!(error.contains("cert not found at /nonexistent/cert.pem"), "{error}");
    }

    #[test]
    fn every_refusal_is_reported_not_just_the_first() {
        let root = test_root();
        let mut env = env_in(&root);
        env.startup.cache_dir_env = Some(root.join("public/cache").display().to_string());
        let errors = validate(
            &parse("[security.csrf]\ntrusted_origins = [\"nope\"]\n\n[revalidate]\ntoken = \"x\"\n")
                .unwrap(),
            &env.startup,
        )
        .err()
        .expect("refused");
        assert_eq!(errors.len(), 3, "{errors:?}");
        assert!(errors[0].starts_with("GIO_CACHE_DIR: "));
        assert!(errors[1].starts_with("[security.csrf] "));
        assert!(errors[2].starts_with("the revalidation token "));
    }

    #[test]
    fn a_missing_local_font_fails_the_check() {
        let root = std::env::temp_dir().join(format!(
            "gio_config_check_fonts_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("public/fonts")).unwrap();
        std::fs::write(root.join("public/fonts/present.woff2"), b"wOF2").unwrap();
        let env = env_in(&root);

        let present = report(
            &loaded(&[]),
            parse(
                "[[fonts]]\nfamily = \"Present\"\nurl = \"/public/fonts/present.woff2\"\n\n\
                 [[fonts]]\nfamily = \"Remote\"\nurl = \"https://fonts.example/r.woff2\"\n",
            ),
            &env,
        );
        assert_eq!(present["ok"], true, "{present}");

        let missing = report(
            &loaded(&[]),
            parse(
                "[[fonts]]\nfamily = \"Present\"\nurl = \"/fonts/present.woff2\"\n\n\
                 [[fonts]]\nfamily = \"Missing\"\nurl = \"/public/fonts/missing.woff2\"\n\n\
                 [[fonts]]\nfamily = \"Escape\"\nurl = \"/../secret.woff2\"\n\n\
                 [[fonts]]\nfamily = \"Dir\"\nurl = \"/fonts\"\n",
            ),
            &env,
        );
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(missing["ok"], false, "{missing}");
        let errors: Vec<&str> = missing["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|error| error.as_str().unwrap())
            .collect();
        assert_eq!(errors.len(), 3, "{errors:?}");
        let missing_path = root.join("public/fonts/missing.woff2");
        assert!(
            errors[0].starts_with(&format!(
                "[[fonts]] Missing: {} not found",
                missing_path.display()
            )),
            "{errors:?}"
        );
        assert!(errors[1].starts_with("[[fonts]] Escape: font url"), "{errors:?}");
        assert!(errors[2].starts_with("[[fonts]] Dir: "), "{errors:?}");
        assert!(errors[2].contains("is not a file"), "{errors:?}");
    }

    #[test]
    fn a_malformed_metrics_allowlist_entry_fails_the_check() {
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse("[metrics]\nip_allowlist = [\"10.0.0.0/33\"]\n"),
            &env_in(&root),
        );
        assert_eq!(report["ok"], false, "{report}");
        let error = report["errors"][0].as_str().unwrap();
        assert!(error.contains("invalid ip_allowlist entry \"10.0.0.0/33\""), "{error}");
    }

    #[test]
    fn validate_accepts_the_defaults() {
        let root = test_root();
        let validated = validate(&parse("").unwrap(), &env_in(&root).startup)
            .unwrap_or_else(|errors| panic!("{errors:?}"));
        assert!(validated.cache_dir.starts_with(&root));
        assert!(validated.revalidate_token.is_none());
        assert!(validated.tls_acceptor.is_none());
    }

    #[test]
    fn a_syntax_error_never_copies_a_secret_into_the_report() {
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse("[revalidate]\ntoken = \"s3cr3t-revalidate-token-0123456789abcdef\" extra\n"),
            &env_in(&root),
        );
        assert_eq!(report["ok"], false);
        assert!(!report.to_string().contains("s3cr3t"), "{report}");
        let error = report["errors"][0].as_str().unwrap();
        assert!(error.starts_with("cannot parse gio.toml:2:"), "{error}");
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

    /// The warnings for `toml` (none expected from anything else in it).
    fn protection_warnings(toml: &str) -> Vec<String> {
        protections_off_warnings(&parse(toml).unwrap())
    }

    #[test]
    fn the_defaults_loosen_no_protection() {
        assert_eq!(protection_warnings(""), Vec::<String>::new());
        let root = test_root();
        assert_eq!(
            report(&loaded(&[]), parse(""), &env_in(&root))["warnings"],
            json!([])
        );
    }

    #[test]
    fn unlimited_websocket_connections_are_a_warning() {
        let warnings = protection_warnings("[websocket]\nmax_connections = 0\n");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].starts_with("[websocket] max_connections = 0: "));
        // Not while WebSockets are off.
        assert!(
            protection_warnings("[websocket]\nenabled = false\nmax_connections = 0\n").is_empty()
        );

        // --check-config reports the same line, and still passes.
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse("[websocket]\nmax_connections = 0\n"),
            &env_in(&root),
        );
        assert_eq!(report["ok"], true);
        assert_eq!(report["warnings"], json!(warnings));
    }

    #[test]
    fn image_limits_lifted_to_zero_are_warnings() {
        let all = "[images]\nmax_remote_bytes = 0\nremote_timeout_secs = 0\n\
                   max_source_dimension = 0\nmax_decode_bytes = 0\n";
        let warnings = protection_warnings(all);
        let keys: Vec<&str> = warnings
            .iter()
            .map(|warning| warning.split(" = 0:").next().unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "[images] max_remote_bytes",
                "[images] remote_timeout_secs",
                "[images] max_source_dimension",
                "[images] max_decode_bytes",
            ]
        );
        // Raised limits are no warning, and neither are any with the
        // optimizer off.
        assert!(protection_warnings("[images]\nmax_source_dimension = 30000\n").is_empty());
        assert!(protection_warnings(&format!("{all}enabled = false\n")).is_empty());
    }

    #[test]
    fn no_render_timeout_is_a_warning() {
        let warnings = protection_warnings("[server]\nrender_timeout_secs = 0\n");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].starts_with("[server] render_timeout_secs = 0: "));
        assert!(protection_warnings("[server]\nrender_timeout_secs = 120\n").is_empty());
    }

    #[test]
    fn lifted_rate_limiter_caps_are_warnings() {
        let warnings = protection_warnings(
            "[server]\nrate_limit_max_buckets = 0\n\n\
             [[rate_limits]]\npath = \"/api/*\"\nkey_header = \"x-api-key\"\nmax_keys_per_client = 0\n\n\
             [[rate_limits]]\npath = \"/login\"\nmax_keys_per_client = 0\n",
        );
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].starts_with("[server] rate_limit_max_buckets = 0: "));
        assert!(warnings[1].starts_with("[[rate_limits]] /api/*: max_keys_per_client = 0 - "));
        // Without rules there are no buckets to cap.
        assert!(protection_warnings("[server]\nrate_limit_max_buckets = 0\n").is_empty());
    }

    #[test]
    fn the_defaults_warn_about_nothing() {
        assert_eq!(protections_off_warnings(&parse("").unwrap()), Vec::<String>::new());
        // Tightened or explicitly scoped settings are no protection off.
        let scoped = parse(
            "[server]\nmax_body_bytes = 1048576\nmax_connections = 64\n\
             trusted_proxies = [\"10.0.0.0/8\"]\n\n\
             [metrics]\nip_allowlist = [\"10.0.0.0/8\"]\n\n\
             [dev]\nallowed_hosts = [\"myvm.local\"]\n",
        )
        .unwrap();
        assert_eq!(protections_off_warnings(&scoped), Vec::<String>::new());
    }

    #[test]
    fn every_protection_turned_off_is_one_warning_naming_its_key() {
        let cases = [
            ("[security.csrf]\nenabled = false\n", "[security.csrf] enabled = false"),
            (
                "[security.websocket]\ncheck_origin = false\n",
                "[security.websocket] check_origin = false",
            ),
            ("[security]\ndefault_headers = false\n", "[security] default_headers = false"),
            ("[dev]\nallowed_hosts = [\"*\"]\n", "[dev] allowed_hosts = [\"*\"]"),
            ("[server]\nmax_body_bytes = 0\n", "[server] max_body_bytes = 0"),
            (
                "[server]\nmax_body_bytes = 104857600\n",
                "[server] max_body_bytes = 104857600 is more than",
            ),
            ("[server]\nmax_connections = 0\n", "[server] max_connections = 0"),
            (
                "[metrics]\nip_allowlist = [\"0.0.0.0/0\", \"::/0\"]\n",
                "[metrics] ip_allowlist includes 0.0.0.0/0",
            ),
            (
                "[server]\ntrusted_proxies = [\"::/0\"]\n",
                "[server] trusted_proxies includes ::/0",
            ),
            ("[server]\nskew_protection = false\n", "[server] skew_protection = false"),
        ];
        for (toml, expected) in cases {
            let warnings = protections_off_warnings(&parse(toml).unwrap());
            assert_eq!(warnings.len(), 1, "{toml}: {warnings:?}");
            assert!(warnings[0].starts_with(expected), "{toml}: {warnings:?}");
        }
        // An open allowlist with a token, or metrics off, opens nothing.
        for toml in [
            "[metrics]\ntoken = \"t\"\nip_allowlist = [\"0.0.0.0/0\"]\n",
            "[metrics]\nenabled = false\nip_allowlist = [\"0.0.0.0/0\"]\n",
        ] {
            assert_eq!(protections_off_warnings(&parse(toml).unwrap()), Vec::<String>::new());
        }
    }

    #[test]
    fn check_config_reports_the_warnings_startup_logs() {
        let root = test_root();
        let report = report(
            &loaded(&[]),
            parse(
                "[security.csrf]\nenabled = false\n\n\
                 [dev]\nallowed_hosts = [\"*\", \"foo*.example\"]\n",
            ),
            &env_in(&root),
        );
        assert_eq!(report["ok"], true, "a loosened protection does not stop startup");
        let warnings: Vec<&str> = report["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|warning| warning.as_str().unwrap())
            .collect();
        assert_eq!(warnings.len(), 3, "{warnings:?}");
        assert!(warnings[0].starts_with("[security.csrf] enabled = false: "));
        assert!(warnings[1].starts_with("[dev] allowed_hosts = [\"*\"]: "));
        // Dev startup ignores the entry; the check says so in any mode.
        assert!(warnings[2]
            .starts_with("ignoring [dev] allowed_hosts entry \"foo*.example\" in gio.toml"));
    }

    #[test]
    fn env_files_turned_off_are_reported_by_their_switch() {
        let root = test_root();
        let mut off = loaded(&[]);
        assert_eq!(report(&off, parse(""), &env_in(&root))["envFilesDisabledBy"], Value::Null);
        off.disabled_by = Some("[env] files");
        let report = report(&off, parse("[env]\nfiles = false\n"), &env_in(&root));
        assert_eq!(report["ok"], true);
        assert_eq!(report["envFilesDisabledBy"], "[env] files");
        assert_eq!(report["envFiles"], json!([]));
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
