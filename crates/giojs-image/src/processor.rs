//! giojs-image/src/processor.rs
//!
//! CPU-bound image resize and format conversion.
//! All public functions must be called from spawn_blocking.

use bytes::Bytes;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;
use thiserror::Error;

/// `DecodeLimits` defaults (gio.toml `[images] max_source_dimension` and
/// `max_decode_bytes`).
pub const DEFAULT_MAX_SOURCE_DIMENSION: u32 = 10_000;
pub const DEFAULT_MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

/// Bounds on decoding one source image. A tiny compressed file can declare
/// enormous dimensions; without decode limits one request can allocate
/// gigabytes inside spawn_blocking. 0 lifts a bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeLimits {
    /// Largest source width or height, in pixels.
    pub max_dimension: u32,
    /// Most bytes the decoder may allocate at once.
    pub max_alloc_bytes: u64,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_dimension: DEFAULT_MAX_SOURCE_DIMENSION,
            max_alloc_bytes: DEFAULT_MAX_DECODE_BYTES,
        }
    }
}

impl DecodeLimits {
    /// As the decoder's limits. Starts from `no_limits`, not the image
    /// crate's defaults, so 0 really is unbounded (its default allocation
    /// cap is 512 MiB).
    fn image_limits(self) -> image::Limits {
        let mut limits = image::Limits::no_limits();
        let dimension = (self.max_dimension > 0).then_some(self.max_dimension);
        limits.max_image_width = dimension;
        limits.max_image_height = dimension;
        limits.max_alloc = (self.max_alloc_bytes > 0).then_some(self.max_alloc_bytes);
        limits
    }
}

#[derive(Debug, Error)]
pub enum ProcessorError {
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("encode failed: {0}")]
    Encode(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Avif,
    WebP,
    Jpeg,
    Png,
}

impl OutputFormat {
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Avif => "image/avif",
            Self::WebP => "image/webp",
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Avif => "avif",
            Self::WebP => "webp",
            Self::Jpeg => "jpg",
            Self::Png => "png",
        }
    }

    /// Format negotiation: AVIF > WebP > JPEG.
    pub fn from_accept(accept: &str) -> Self {
        Self::negotiate(accept, &Self::MODERN)
    }

    /// The modern formats, in default preference order.
    pub const MODERN: [Self; 2] = [Self::Avif, Self::WebP];

    /// The first of `preferred` (gio.toml `[images] formats`) the Accept
    /// header names, else JPEG.
    pub fn negotiate(accept: &str, preferred: &[Self]) -> Self {
        preferred
            .iter()
            .copied()
            .find(|format| accept.contains(format.content_type()))
            .unwrap_or(Self::Jpeg)
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "avif" => Some(Self::Avif),
            "webp" => Some(Self::WebP),
            "jpeg" | "jpg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImageParams {
    pub width: Option<u32>,
    pub quality: u8,
    pub format: OutputFormat,
}

pub struct ProcessedImage {
    pub data: Bytes,
    pub format: OutputFormat,
}

/// `process_image_with_limits` with the default `DecodeLimits`.
pub fn process_image(
    source: Bytes,
    params: &ImageParams,
) -> Result<ProcessedImage, ProcessorError> {
    process_image_with_limits(source, params, DecodeLimits::default())
}

pub fn process_image_with_limits(
    source: Bytes,
    params: &ImageParams,
    decode_limits: DecodeLimits,
) -> Result<ProcessedImage, ProcessorError> {
    let mut reader = ImageReader::new(Cursor::new(&source))
        .with_guessed_format()
        .map_err(|e| ProcessorError::Decode(e.to_string()))?;
    reader.limits(decode_limits.image_limits());
    let img = reader
        .decode()
        .map_err(|e| ProcessorError::Decode(e.to_string()))?;

    let img = match params.width {
        Some(target_w) if target_w < img.width() => {
            img.resize(target_w, u32::MAX, image::imageops::FilterType::Lanczos3)
        }
        _ => img, // no upscaling - serve at source width
    };

    let data = encode(&img, params)?;
    Ok(ProcessedImage {
        data,
        format: params.format,
    })
}

fn encode(img: &DynamicImage, params: &ImageParams) -> Result<Bytes, ProcessorError> {
    let mut buf = Cursor::new(Vec::new());
    match params.format {
        OutputFormat::Jpeg => {
            use image::codecs::jpeg::JpegEncoder;
            JpegEncoder::new_with_quality(&mut buf, params.quality)
                .encode_image(img)
                .map_err(|e| ProcessorError::Encode(e.to_string()))?;
        }
        OutputFormat::WebP => {
            img.write_to(&mut buf, ImageFormat::WebP)
                .map_err(|e| ProcessorError::Encode(e.to_string()))?;
        }
        OutputFormat::Avif => {
            img.write_to(&mut buf, ImageFormat::Avif)
                .map_err(|e| ProcessorError::Encode(e.to_string()))?;
        }
        OutputFormat::Png => {
            img.write_to(&mut buf, ImageFormat::Png)
                .map_err(|e| ProcessorError::Encode(e.to_string()))?;
        }
    }
    Ok(Bytes::from(buf.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, Rgb};

    fn make_test_jpeg(w: u32, h: u32) -> Bytes {
        use image::codecs::jpeg::JpegEncoder;
        let img = DynamicImage::ImageRgb8(ImageBuffer::<Rgb<u8>, _>::from_fn(w, h, |x, y| {
            Rgb([x as u8, y as u8, 128])
        }));
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, 80)
            .encode_image(&img)
            .unwrap();
        Bytes::from(buf)
    }

    #[test]
    fn jpeg_to_webp_correct_dims() {
        let src = make_test_jpeg(800, 600);
        let params = ImageParams {
            width: Some(400),
            quality: 75,
            format: OutputFormat::WebP,
        };
        let result = process_image(src, &params).unwrap();
        let decoded = image::load_from_memory(&result.data).unwrap();
        assert_eq!(decoded.width(), 400);
    }

    #[test]
    fn no_upscaling() {
        let src = make_test_jpeg(200, 150);
        let params = ImageParams {
            width: Some(400),
            quality: 75,
            format: OutputFormat::Jpeg,
        };
        let result = process_image(src, &params).unwrap();
        let decoded = image::load_from_memory(&result.data).unwrap();
        assert_eq!(decoded.width(), 200);
    }

    #[test]
    fn decode_limits_bound_the_source_and_zero_lifts_them() {
        let params = ImageParams {
            width: Some(64),
            quality: 75,
            format: OutputFormat::Jpeg,
        };
        let src = make_test_jpeg(300, 200);
        let small = DecodeLimits {
            max_dimension: 250,
            ..DecodeLimits::default()
        };
        assert!(matches!(
            process_image_with_limits(src.clone(), &params, small),
            Err(ProcessorError::Decode(_))
        ));
        let tiny_alloc = DecodeLimits {
            max_alloc_bytes: 1024,
            ..DecodeLimits::default()
        };
        assert!(process_image_with_limits(src.clone(), &params, tiny_alloc).is_err());
        let unbounded = DecodeLimits {
            max_dimension: 0,
            max_alloc_bytes: 0,
        };
        assert_eq!(unbounded.image_limits().max_alloc, None, "not the crate's 512 MiB");
        assert_eq!(unbounded.image_limits().max_image_width, None);
        assert!(process_image_with_limits(src.clone(), &params, unbounded).is_ok());
        assert!(process_image(src, &params).is_ok(), "the defaults admit it");
    }

    #[test]
    fn format_negotiation_avif_preferred() {
        assert_eq!(
            OutputFormat::from_accept("image/avif,image/webp,*/*"),
            OutputFormat::Avif
        );
    }

    #[test]
    fn format_negotiation_webp_fallback() {
        assert_eq!(
            OutputFormat::from_accept("image/webp,*/*"),
            OutputFormat::WebP
        );
    }

    #[test]
    fn format_negotiation_jpeg_default() {
        assert_eq!(OutputFormat::from_accept("*/*"), OutputFormat::Jpeg);
    }

    #[test]
    fn format_negotiation_follows_the_configured_preference() {
        let modern = "image/avif,image/webp,*/*";
        let webp_only = [OutputFormat::WebP];
        assert_eq!(
            OutputFormat::negotiate(modern, &webp_only),
            OutputFormat::WebP
        );
        let webp_first = [OutputFormat::WebP, OutputFormat::Avif];
        assert_eq!(
            OutputFormat::negotiate(modern, &webp_first),
            OutputFormat::WebP
        );
        assert_eq!(
            OutputFormat::negotiate("image/avif,*/*", &webp_first),
            OutputFormat::Avif
        );
        assert_eq!(OutputFormat::negotiate(modern, &[]), OutputFormat::Jpeg);
    }
}
