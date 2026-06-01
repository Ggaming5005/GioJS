//! giojs-image/src/processor.rs
//!
//! CPU-bound image resize and format conversion.
//! All public functions must be called from spawn_blocking.

use bytes::Bytes;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;
use thiserror::Error;

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
        if accept.contains("image/avif") {
            Self::Avif
        } else if accept.contains("image/webp") {
            Self::WebP
        } else {
            Self::Jpeg
        }
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

pub fn process_image(
    source: Bytes,
    params: &ImageParams,
) -> Result<ProcessedImage, ProcessorError> {
    let reader = ImageReader::new(Cursor::new(&source))
        .with_guessed_format()
        .map_err(|e| ProcessorError::Decode(e.to_string()))?;
    let img = reader
        .decode()
        .map_err(|e| ProcessorError::Decode(e.to_string()))?;

    let img = match params.width {
        Some(target_w) if target_w < img.width() => {
            img.resize(target_w, u32::MAX, image::imageops::FilterType::Lanczos3)
        }
        _ => img, // no upscaling — serve at source width
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
}
