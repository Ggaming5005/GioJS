//! giojs-server/src/dev_codeframe.rs
//!
//! Pure helpers behind the dev-only /_gio/devtools/codeframe and
//! /_gio/devtools/open-in-editor endpoints: project-root path validation
//! (CLAUDE.md 6.1), source line-window extraction for the error overlay,
//! and editor command construction from GIO_EDITOR/VISUAL/EDITOR specs.

use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

/// Lines of context shown above and below the failing line.
pub const CODEFRAME_CONTEXT_LINES: usize = 4;

/// Upper bound on source files the codeframe endpoint will read.
pub const MAX_SOURCE_FILE_BYTES: u64 = 2 * 1024 * 1024;

// Allowlist keeps the dev endpoint from disclosing .env and friends.
const SOURCE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "css", "rs",
];

#[derive(Debug, Error)]
pub enum CodeframeError {
    #[error("invalid path")]
    InvalidPath,
    #[error("path outside project root")]
    OutsideRoot,
    #[error("file not found")]
    NotFound,
    #[error("not a source file")]
    NotSourceFile,
    #[error("line {line} out of range (file has {total} lines)")]
    LineOutOfRange { line: usize, total: usize },
    #[error("file too large")]
    TooLarge,
    #[error("file read failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeframeLine {
    pub no: usize,
    pub text: String,
}

/// Resolve `requested` (absolute, or relative to `root`) to a canonical path
/// that is provably inside `root` and has a source-file extension.
pub fn validate_project_path(root: &Path, requested: &str) -> Result<PathBuf, CodeframeError> {
    if requested.trim().is_empty() {
        return Err(CodeframeError::InvalidPath);
    }
    let requested_path = Path::new(requested);
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        root.join(requested_path)
    };
    let extension_allowed = joined
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SOURCE_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        });
    if !extension_allowed {
        return Err(CodeframeError::NotSourceFile);
    }
    // Canonicalizing both sides makes prefix comparison sound on Windows,
    // where canonical paths carry the \\?\ verbatim prefix.
    let canonical_root = root
        .canonicalize()
        .map_err(|_| CodeframeError::InvalidPath)?;
    let canonical = joined
        .canonicalize()
        .map_err(|_| CodeframeError::NotFound)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(CodeframeError::OutsideRoot);
    }
    Ok(canonical)
}

/// Extract the 1-indexed `line` plus `CODEFRAME_CONTEXT_LINES` of context on
/// each side, clamped to the file bounds.
pub fn extract_codeframe(source: &str, line: usize) -> Result<Vec<CodeframeLine>, CodeframeError> {
    let all_lines: Vec<&str> = source.lines().collect();
    if line == 0 || line > all_lines.len() {
        return Err(CodeframeError::LineOutOfRange {
            line,
            total: all_lines.len(),
        });
    }
    let start = line.saturating_sub(CODEFRAME_CONTEXT_LINES + 1);
    let end = (line + CODEFRAME_CONTEXT_LINES).min(all_lines.len());
    Ok(all_lines[start..end]
        .iter()
        .enumerate()
        .map(|(offset, text)| CodeframeLine {
            no: start + offset + 1,
            text: (*text).to_string(),
        })
        .collect())
}

/// Path as a string an editor accepts: canonicalize's `\\?\` verbatim
/// prefix on Windows confuses most editors, so it is stripped.
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

/// Build (program, args) from an editor spec like `code`, `subl -w`, or
/// `vim`. VS Code-family editors get the `-g file:line` goto form; everything
/// else gets a plain `file:line` argument. Returns `None` for an empty spec.
pub fn editor_command(editor_spec: &str, file: &str, line: usize) -> Option<(String, Vec<String>)> {
    let mut parts = editor_spec.split_whitespace();
    let program = parts.next()?.to_string();
    let mut args: Vec<String> = parts.map(str::to_string).collect();
    let program_stem = Path::new(&program)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(program.as_str())
        .to_ascii_lowercase();
    let is_goto_editor = matches!(
        program_stem.as_str(),
        "code" | "code-insiders" | "codium" | "vscodium" | "cursor" | "windsurf"
    );
    if is_goto_editor && !args.iter().any(|arg| arg == "-g" || arg == "--goto") {
        args.push("-g".to_string());
    }
    args.push(format!("{file}:{line}"));
    Some((program, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("gio_codeframe_test_{tag}"));
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/page.tsx"), "export default 1;\n").unwrap();
        std::fs::write(root.join("app/secret.env"), "TOKEN=x\n").unwrap();
        std::fs::write(root.join("outside.ts"), "export {};\n").unwrap();
        root
    }

    #[test]
    fn relative_path_inside_root_is_accepted() {
        let root = temp_project_root("inside");
        let resolved = validate_project_path(&root, "app/page.tsx").unwrap();
        assert!(resolved.ends_with("page.tsx"));
    }

    #[test]
    fn absolute_path_inside_root_is_accepted() {
        let root = temp_project_root("abs_inside");
        let absolute = root.join("app").join("page.tsx");
        let resolved = validate_project_path(&root, absolute.to_str().unwrap()).unwrap();
        assert!(resolved.ends_with("page.tsx"));
    }

    #[test]
    fn dotdot_traversal_is_rejected() {
        let root = temp_project_root("traversal").join("app");
        let result = validate_project_path(&root, "../outside.ts");
        assert!(matches!(result, Err(CodeframeError::OutsideRoot)));
    }

    #[test]
    fn absolute_path_outside_root_is_rejected() {
        let outside_root = temp_project_root("outside_target");
        let root = temp_project_root("outside").join("app");
        let outside = outside_root.join("app").join("page.tsx");
        let result = validate_project_path(&root, outside.to_str().unwrap());
        assert!(matches!(result, Err(CodeframeError::OutsideRoot)));
    }

    #[test]
    fn missing_file_is_not_found() {
        let root = temp_project_root("missing");
        let result = validate_project_path(&root, "app/nope.tsx");
        assert!(matches!(result, Err(CodeframeError::NotFound)));
    }

    #[test]
    fn non_source_extension_is_rejected() {
        let root = temp_project_root("env");
        let result = validate_project_path(&root, "app/secret.env");
        assert!(matches!(result, Err(CodeframeError::NotSourceFile)));
    }

    #[test]
    fn empty_path_is_invalid() {
        let root = temp_project_root("empty");
        assert!(matches!(
            validate_project_path(&root, "  "),
            Err(CodeframeError::InvalidPath)
        ));
    }

    #[test]
    fn codeframe_window_centers_on_line() {
        let source = (1..=20)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let lines = extract_codeframe(&source, 10).unwrap();
        assert_eq!(lines.first().unwrap().no, 6);
        assert_eq!(lines.last().unwrap().no, 14);
        assert_eq!(lines.len(), 9);
        assert_eq!(lines[4].text, "line 10");
    }

    #[test]
    fn codeframe_clamps_at_file_start() {
        let source = "a\nb\nc\nd\ne\nf";
        let lines = extract_codeframe(source, 1).unwrap();
        assert_eq!(lines.first().unwrap().no, 1);
        assert_eq!(lines.last().unwrap().no, 5);
    }

    #[test]
    fn codeframe_clamps_at_file_end() {
        let source = "a\nb\nc\nd\ne\nf";
        let lines = extract_codeframe(source, 6).unwrap();
        assert_eq!(lines.first().unwrap().no, 2);
        assert_eq!(lines.last().unwrap().no, 6);
    }

    #[test]
    fn codeframe_rejects_out_of_range_line() {
        let source = "a\nb";
        assert!(matches!(
            extract_codeframe(source, 0),
            Err(CodeframeError::LineOutOfRange { .. })
        ));
        assert!(matches!(
            extract_codeframe(source, 3),
            Err(CodeframeError::LineOutOfRange { line: 3, total: 2 })
        ));
    }

    #[test]
    fn code_editor_gets_goto_flag() {
        let (program, args) = editor_command("code", "app/page.tsx", 7).unwrap();
        assert_eq!(program, "code");
        assert_eq!(args, vec!["-g".to_string(), "app/page.tsx:7".to_string()]);
    }

    #[test]
    fn plain_editor_gets_file_line_argument() {
        let (program, args) = editor_command("vim", "app/page.tsx", 7).unwrap();
        assert_eq!(program, "vim");
        assert_eq!(args, vec!["app/page.tsx:7".to_string()]);
    }

    #[test]
    fn multi_token_spec_keeps_extra_args() {
        let (program, args) = editor_command("subl -w", "a.ts", 3).unwrap();
        assert_eq!(program, "subl");
        assert_eq!(args, vec!["-w".to_string(), "a.ts:3".to_string()]);
    }

    #[test]
    fn empty_spec_yields_no_command() {
        assert!(editor_command("   ", "a.ts", 1).is_none());
    }

    #[test]
    fn display_path_strips_windows_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\proj\app\page.tsx")),
            r"C:\proj\app\page.tsx"
        );
        assert_eq!(
            display_path(Path::new("/proj/app/page.tsx")),
            "/proj/app/page.tsx"
        );
    }
}
