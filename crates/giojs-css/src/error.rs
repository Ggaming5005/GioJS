//! giojs-css/src/error.rs
//!
//! Error types for the CSS processing pipeline.

#[derive(Debug, thiserror::Error)]
pub enum CssError {
    #[error("CSS parse error: {0}")]
    Parse(String),
    #[error("CSS transform error: {0}")]
    Transform(String),
    #[error("CSS print error: {0}")]
    Print(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
