//! giojs-css
//!
//! CSS processing pipeline for GioJS. Wraps Lightning CSS for transformation
//! (minification, vendor prefixes, CSS Modules) and provides critical CSS
//! extraction for zero-render-blocking first paint.
//!
//! This crate owns CSS logic only — no HTTP handling, no routing, no caching.

pub mod critical;
pub mod error;
pub mod modules;
pub mod transform;

pub use critical::{extract_critical, CriticalResult};
pub use error::CssError;
pub use modules::hash_class_name;
pub use transform::{CssTransformer, TransformResult};
