//! Color-space conversion for the video publish path.
//!
//! Capture backends produce packed RGB/BGRA frames; LiveKit's `NativeVideoSource` wants
//! planar I420 (YUV 4:2:0). These helpers do a straightforward BT.601 conversion in pure
//! Rust so we don't pull in a native color-conversion dependency. Capture resolutions are
//! downscaled by the backends where appropriate, keeping this cheap enough per frame.

/// A planar I420 frame with tightly-packed planes (stride == width / chroma width).
#[derive(Clone)]
pub struct I420Frame {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

impl I420Frame {
    fn allocate(width: u32, height: u32) -> Self {
        let w = width as usize;
        let h = height as usize;
        let cw = (w + 1) / 2;
        let ch = (h + 1) / 2;
        Self {
            width,
            height,
            y: vec![0; w * h],
            u: vec![0; cw * ch],
            v: vec![0; cw * ch],
        }
    }

    pub fn chroma_width(&self) -> u32 {
        (self.width + 1) / 2
    }

    pub fn chroma_height(&self) -> u32 {
        (self.height + 1) / 2
    }
}

/// Resize a planar I420 frame to an exact output size. Downscales use an area average so
/// desktop text keeps its edges instead of aliasing into blocky pixels; upscales use
/// bilinear interpolation. Capture backends may choose their own native dimensions, but
/// LiveKit's `NativeVideoSource` is created with the profile dimensions, so the publish path
/// must hand it matching frames.
pub fn resize_i420_filtered(src: &I420Frame, width: u32, height: u32) -> I420Frame {
    let width = width.max(2);
    let height = height.max(2);
    if src.width == width && src.height == height {
        return src.clone();
    }

    let mut y = vec![0; (width * height) as usize];
    resize_plane_filtered(&src.y, src.width, src.height, &mut y, width, height);

    let src_cw = src.chroma_width();
    let src_ch = src.chroma_height();
    let cw = (width + 1) / 2;
    let ch = (height + 1) / 2;
    let mut u = vec![0; (cw * ch) as usize];
    let mut v = vec![0; (cw * ch) as usize];
    resize_plane_filtered(&src.u, src_cw, src_ch, &mut u, cw, ch);
    resize_plane_filtered(&src.v, src_cw, src_ch, &mut v, cw, ch);

    I420Frame {
        width,
        height,
        y,
        u,
        v,
    }
}

/// Resize a frame to fit inside `width` x `height` without changing its shape, centred on
/// black (limited range). A shared window that is resized, or a display whose resolution
/// changes, keeps its proportions instead of being stretched to the published size.
pub fn letterbox_i420(src: &I420Frame, width: u32, height: u32) -> I420Frame {
    let width = width.max(2);
    let height = height.max(2);
    let (src_w, src_h) = (src.width.max(1) as u64, src.height.max(1) as u64);
    // Same shape within one pixel: plain resize.
    let fitted_height = (width as u64 * src_h / src_w) as u32;
    if fitted_height.abs_diff(height) <= 1 {
        return resize_i420_filtered(src, width, height);
    }
    let even = |value: u64| ((value as u32) & !1).max(2);
    let (inner_w, inner_h) = if fitted_height < height {
        (width & !1, even(width as u64 * src_h / src_w))
    } else {
        (even(height as u64 * src_w / src_h), height & !1)
    };
    let inner = resize_i420_filtered(src, inner_w.max(2), inner_h.max(2));
    let mut out = I420Frame::allocate(width, height);
    out.y.fill(16);
    out.u.fill(128);
    out.v.fill(128);
    // Even offsets keep the chroma planes aligned with luma.
    let x = ((width - inner.width) / 2) & !1;
    let y = ((height - inner.height) / 2) & !1;
    paste_plane(&inner.y, inner.width, inner.height, &mut out.y, width, x, y);
    let (cw, icw, ich) = (
        out.chroma_width(),
        inner.chroma_width(),
        inner.chroma_height(),
    );
    paste_plane(&inner.u, icw, ich, &mut out.u, cw, x / 2, y / 2);
    paste_plane(&inner.v, icw, ich, &mut out.v, cw, x / 2, y / 2);
    out
}

fn paste_plane(src: &[u8], src_w: u32, src_h: u32, dst: &mut [u8], dst_w: u32, x: u32, y: u32) {
    let (src_w, dst_w, x) = (src_w as usize, dst_w as usize, x as usize);
    for row in 0..src_h as usize {
        let at = (y as usize + row) * dst_w + x;
        dst[at..at + src_w].copy_from_slice(&src[row * src_w..(row + 1) * src_w]);
    }
}

/// Reusing variant for the local presentation bridge, which must avoid a new allocation on
/// every remote frame.
pub fn resize_i420_filtered_reusing(
    src: &I420Frame,
    width: u32,
    height: u32,
    target: &mut I420Frame,
) {
    let width = width.max(2);
    let height = height.max(2);
    target.width = width;
    target.height = height;
    target.y.resize((width * height) as usize, 0);
    resize_plane_filtered(&src.y, src.width, src.height, &mut target.y, width, height);

    let source_chroma_width = src.chroma_width();
    let source_chroma_height = src.chroma_height();
    let chroma_width = width.div_ceil(2);
    let chroma_height = height.div_ceil(2);
    target.u.resize((chroma_width * chroma_height) as usize, 0);
    target.v.resize((chroma_width * chroma_height) as usize, 0);
    resize_plane_filtered(
        &src.u,
        source_chroma_width,
        source_chroma_height,
        &mut target.u,
        chroma_width,
        chroma_height,
    );
    resize_plane_filtered(
        &src.v,
        source_chroma_width,
        source_chroma_height,
        &mut target.v,
        chroma_width,
        chroma_height,
    );
}

fn resize_plane_filtered(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    if target_width <= source_width && target_height <= source_height {
        resize_plane_area(
            source,
            source_width,
            source_height,
            target,
            target_width,
            target_height,
        );
    } else {
        resize_plane_bilinear(
            source,
            source_width,
            source_height,
            target,
            target_width,
            target_height,
        );
    }
}

fn resize_plane_area(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    for target_row in 0..target_height {
        let start_row = target_row * source_height / target_height;
        let end_row = ((target_row + 1) * source_height)
            .div_ceil(target_height)
            .min(source_height);
        for target_column in 0..target_width {
            let start_column = target_column * source_width / target_width;
            let end_column = ((target_column + 1) * source_width)
                .div_ceil(target_width)
                .min(source_width);
            let mut sum = 0_u32;
            let mut count = 0_u32;
            for source_row in start_row..end_row {
                for source_column in start_column..end_column {
                    sum += source[(source_row * source_width + source_column) as usize] as u32;
                    count += 1;
                }
            }
            target[(target_row * target_width + target_column) as usize] =
                (sum / count.max(1)) as u8;
        }
    }
}

fn resize_plane_bilinear(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    target: &mut [u8],
    target_width: u32,
    target_height: u32,
) {
    let x_scale =
        source_width.saturating_sub(1) as f64 / target_width.saturating_sub(1).max(1) as f64;
    let y_scale =
        source_height.saturating_sub(1) as f64 / target_height.saturating_sub(1).max(1) as f64;
    for target_row in 0..target_height {
        let source_y = target_row as f64 * y_scale;
        let y0 = source_y.floor() as u32;
        let y1 = (y0 + 1).min(source_height.saturating_sub(1));
        let fy = source_y - y0 as f64;
        for target_column in 0..target_width {
            let source_x = target_column as f64 * x_scale;
            let x0 = source_x.floor() as u32;
            let x1 = (x0 + 1).min(source_width.saturating_sub(1));
            let fx = source_x - x0 as f64;
            let top = source[(y0 * source_width + x0) as usize] as f64 * (1.0 - fx)
                + source[(y0 * source_width + x1) as usize] as f64 * fx;
            let bottom = source[(y1 * source_width + x0) as usize] as f64 * (1.0 - fx)
                + source[(y1 * source_width + x1) as usize] as f64 * fx;
            target[(target_row * target_width + target_column) as usize] =
                (top * (1.0 - fy) + bottom * fy).round() as u8;
        }
    }
}

/// Convert a tightly-packed I420 frame to RGB for local preview rendering.
/// Publishing remains I420 end-to-end; this conversion is used only by the
/// throttled desktop preview bridge.
pub fn i420_to_rgb(frame: &I420Frame) -> Vec<u8> {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let chroma_width = frame.chroma_width() as usize;
    let mut rgb = vec![0; width * height * 3];

    for row in 0..height {
        for col in 0..width {
            let y = frame.y[row * width + col] as i32;
            let chroma_index = (row / 2) * chroma_width + (col / 2);
            let u = frame.u[chroma_index] as i32;
            let v = frame.v[chroma_index] as i32;
            let c = (y - 16).max(0);
            let d = u - 128;
            let e = v - 128;
            let offset = (row * width + col) * 3;
            rgb[offset] = ((298 * c + 409 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 1] = ((298 * c - 100 * d - 208 * e + 128) >> 8).clamp(0, 255) as u8;
            rgb[offset + 2] = ((298 * c + 516 * d + 128) >> 8).clamp(0, 255) as u8;
        }
    }

    rgb
}

#[derive(Clone, Copy)]
pub enum PackedFormat {
    /// 4 bytes per pixel, byte order B, G, R, A.
    Bgra,
    /// 3 bytes per pixel, byte order B, G, R (e.g. a Windows RGB24 DIB).
    Bgr,
    /// 3 bytes per pixel, byte order R, G, B.
    Rgb,
    /// 4 bytes per pixel, byte order R, G, B, A.
    Rgba,
}

impl PackedFormat {
    fn bytes_per_pixel(self) -> usize {
        match self {
            PackedFormat::Bgra | PackedFormat::Rgba => 4,
            PackedFormat::Bgr | PackedFormat::Rgb => 3,
        }
    }

    #[inline]
    fn rgb_at(self, chunk: &[u8]) -> (u8, u8, u8) {
        match self {
            PackedFormat::Bgra | PackedFormat::Bgr => (chunk[2], chunk[1], chunk[0]),
            PackedFormat::Rgb | PackedFormat::Rgba => (chunk[0], chunk[1], chunk[2]),
        }
    }
}

#[inline]
fn rgb_to_y(r: u8, g: u8, b: u8) -> u8 {
    let y = (66 * r as i32 + 129 * g as i32 + 25 * b as i32 + 128) >> 8;
    (y + 16).clamp(0, 255) as u8
}

#[inline]
fn rgb_to_u(r: u8, g: u8, b: u8) -> u8 {
    let u = (-38 * r as i32 - 74 * g as i32 + 112 * b as i32 + 128) >> 8;
    (u + 128).clamp(0, 255) as u8
}

#[inline]
fn rgb_to_v(r: u8, g: u8, b: u8) -> u8 {
    let v = (112 * r as i32 - 94 * g as i32 - 18 * b as i32 + 128) >> 8;
    (v + 128).clamp(0, 255) as u8
}

/// Convert a packed RGB/BGRA buffer into a tightly-packed I420 frame.
///
/// `src_stride` is the number of bytes per source row (may include padding). Rows/cols
/// beyond the requested `width`/`height` are ignored.
pub fn packed_to_i420(
    src: &[u8],
    width: u32,
    height: u32,
    src_stride: usize,
    format: PackedFormat,
) -> Option<I420Frame> {
    if width == 0 || height == 0 {
        return None;
    }
    let bpp = format.bytes_per_pixel();
    let w = width as usize;
    let h = height as usize;
    if src_stride < w * bpp || src.len() < src_stride * h {
        return None;
    }

    let mut frame = I420Frame::allocate(width, height);
    let cw = frame.chroma_width() as usize;

    // Luma: every pixel.
    for row in 0..h {
        let row_start = row * src_stride;
        let y_row = row * w;
        for col in 0..w {
            let px = row_start + col * bpp;
            let (r, g, b) = format.rgb_at(&src[px..px + bpp]);
            frame.y[y_row + col] = rgb_to_y(r, g, b);
        }
    }

    // Chroma: average each 2x2 block, then sample.
    for crow in 0..frame.chroma_height() as usize {
        for ccol in 0..cw {
            let r0 = crow * 2;
            let c0 = ccol * 2;
            let mut rsum = 0u32;
            let mut gsum = 0u32;
            let mut bsum = 0u32;
            let mut count = 0u32;
            for dr in 0..2 {
                let row = r0 + dr;
                if row >= h {
                    continue;
                }
                for dc in 0..2 {
                    let col = c0 + dc;
                    if col >= w {
                        continue;
                    }
                    let px = row * src_stride + col * bpp;
                    let (r, g, b) = format.rgb_at(&src[px..px + bpp]);
                    rsum += r as u32;
                    gsum += g as u32;
                    bsum += b as u32;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let r = (rsum / count) as u8;
            let g = (gsum / count) as u8;
            let b = (bsum / count) as u8;
            let idx = crow * cw + ccol;
            frame.u[idx] = rgb_to_u(r, g, b);
            frame.v[idx] = rgb_to_v(r, g, b);
        }
    }

    Some(frame)
}

/// Where GStreamer puts the planes of a raw `I420` buffer: rows are rounded up to four
/// bytes and plane heights to even rows. A 1366-wide frame has 1368-byte luma rows, so
/// reading it as tightly packed shears the picture and misplaces every later frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GstI420Layout {
    pub y_stride: usize,
    pub chroma_stride: usize,
    pub u_offset: usize,
    pub v_offset: usize,
    /// Bytes per frame on the wire.
    pub size: usize,
}

impl GstI420Layout {
    pub fn new(width: u32, height: u32) -> Self {
        let round4 = |v: usize| (v + 3) & !3;
        let (w, h) = (width as usize, height as usize);
        let even_h = (h + 1) & !1;
        let y_stride = round4(w);
        let chroma_stride = round4(w.div_ceil(2));
        let u_offset = y_stride * even_h;
        let v_offset = u_offset + chroma_stride * (even_h / 2);
        Self {
            y_stride,
            chroma_stride,
            u_offset,
            v_offset,
            size: v_offset + chroma_stride * (even_h / 2),
        }
    }

    /// Copy one wire frame into a tight I420 frame.
    pub fn to_i420(&self, width: u32, height: u32, raw: &[u8]) -> Option<I420Frame> {
        if raw.len() < self.size || width == 0 || height == 0 {
            return None;
        }
        let mut frame = I420Frame::allocate(width, height);
        let (w, h) = (width as usize, height as usize);
        let (cw, ch) = (
            frame.chroma_width() as usize,
            frame.chroma_height() as usize,
        );
        for row in 0..h {
            frame.y[row * w..(row + 1) * w].copy_from_slice(&raw[row * self.y_stride..][..w]);
        }
        for row in 0..ch {
            let at = row * self.chroma_stride;
            frame.u[row * cw..(row + 1) * cw].copy_from_slice(&raw[self.u_offset + at..][..cw]);
            frame.v[row * cw..(row + 1) * cw].copy_from_slice(&raw[self.v_offset + at..][..cw]);
        }
        Some(frame)
    }
}

/// Layouts of the YUV buffers capture devices hand out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YuvLayout {
    /// Y plane, then one plane of interleaved U and V at half resolution.
    Nv12,
    /// Y plane, then U and V planes at half resolution (rows of `stride / 2` bytes).
    I420,
    /// One packed plane of Y0 U Y1 V, chroma at half horizontal resolution.
    Yuy2,
}

impl YuvLayout {
    /// The row stride of a `width` x `height` frame that fills `len` bytes, if the buffer
    /// is large enough for it. Devices may pad rows, so the stride is read from the size.
    pub fn stride_for(self, len: usize, width: u32, height: u32) -> Option<usize> {
        let w = width as usize;
        let h = height as usize;
        if w == 0 || h == 0 {
            return None;
        }
        let (rows, min) = match self {
            YuvLayout::Nv12 | YuvLayout::I420 => (h + h.div_ceil(2), w + (w & 1)),
            YuvLayout::Yuy2 => (h, w.div_ceil(2) * 4),
        };
        let stride = len / rows;
        (stride >= min).then_some(stride)
    }
}

/// Convert a YUV capture buffer with rows of `stride` bytes into a tight I420 frame.
pub fn yuv_to_i420(
    src: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    layout: YuvLayout,
) -> Option<I420Frame> {
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 {
        return None;
    }
    let mut frame = I420Frame::allocate(width, height);
    let cw = frame.chroma_width() as usize;
    let ch = frame.chroma_height() as usize;
    match layout {
        YuvLayout::Nv12 | YuvLayout::I420 => {
            let (chroma_stride, chroma_bytes, chroma_rows) = if layout == YuvLayout::Nv12 {
                (stride, cw * 2, ch)
            } else {
                (stride / 2, cw, ch * 2)
            };
            let chroma_start = stride * h;
            let needed = chroma_start + chroma_stride * (chroma_rows - 1) + chroma_bytes;
            if stride < w || chroma_stride < chroma_bytes || src.len() < needed {
                return None;
            }
            for row in 0..h {
                frame.y[row * w..(row + 1) * w]
                    .copy_from_slice(&src[row * stride..row * stride + w]);
            }
            for row in 0..ch {
                let out = row * cw..(row + 1) * cw;
                if layout == YuvLayout::Nv12 {
                    let line = &src[chroma_start + row * stride..][..cw * 2];
                    for (i, pair) in line.chunks_exact(2).enumerate() {
                        frame.u[out.start + i] = pair[0];
                        frame.v[out.start + i] = pair[1];
                    }
                } else {
                    let u = chroma_start + row * chroma_stride;
                    let v = chroma_start + ch * chroma_stride + row * chroma_stride;
                    frame.u[out.clone()].copy_from_slice(&src[u..u + cw]);
                    frame.v[out].copy_from_slice(&src[v..v + cw]);
                }
            }
        }
        YuvLayout::Yuy2 => {
            if stride < cw * 4 || src.len() < stride * (h - 1) + cw * 4 {
                return None;
            }
            for row in 0..h {
                let line = &src[row * stride..][..cw * 4];
                for col in 0..w {
                    frame.y[row * w + col] = line[(col / 2) * 4 + (col & 1) * 2];
                }
            }
            // Chroma is full height in YUY2: average each pair of rows.
            for crow in 0..ch {
                let top = &src[crow * 2 * stride..][..cw * 4];
                let bottom_row = (crow * 2 + 1).min(h - 1);
                let bottom = &src[bottom_row * stride..][..cw * 4];
                for ccol in 0..cw {
                    let i = crow * cw + ccol;
                    let average =
                        |at: usize| (top[at] as u16 + bottom[at] as u16).div_ceil(2) as u8;
                    frame.u[i] = average(ccol * 4 + 1);
                    frame.v[i] = average(ccol * 4 + 3);
                }
            }
        }
    }
    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gstreamer_i420_rows_are_padded_to_four_bytes() {
        // 1366x768 (a common laptop display): luma rows 1368, chroma rows 684.
        let layout = GstI420Layout::new(1366, 768);
        assert_eq!((layout.y_stride, layout.chroma_stride), (1368, 684));
        assert_eq!(layout.size, 1368 * 768 + 2 * 684 * 384);
        // Widths that are a multiple of 8 are tight.
        assert_eq!(GstI420Layout::new(1280, 720).size, 1280 * 720 * 3 / 2);
    }

    #[test]
    fn gstreamer_i420_padding_is_dropped() {
        // 2x2: luma rows of 4 bytes (2 used), chroma rows of 4 bytes (1 used).
        let layout = GstI420Layout::new(2, 2);
        let raw = [1, 2, 0, 0, 3, 4, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0];
        assert_eq!(layout.size, raw.len());
        let frame = layout.to_i420(2, 2, &raw).unwrap();
        assert_eq!(frame.y, vec![1, 2, 3, 4]);
        assert_eq!((frame.u[0], frame.v[0]), (10, 20));
    }

    #[test]
    fn a_wider_frame_is_letterboxed_on_black_not_stretched() {
        // 8x2 white into 8x8: picture 8x2 in the middle, black above and below.
        let src = I420Frame {
            width: 8,
            height: 2,
            y: vec![235; 16],
            u: vec![128; 4],
            v: vec![128; 4],
        };
        let out = letterbox_i420(&src, 8, 8);
        assert_eq!((out.width, out.height), (8, 8));
        assert_eq!(&out.y[..8], &[16; 8]);
        assert_eq!(&out.y[3 * 8..4 * 8], &[235; 8]);
        assert_eq!(&out.y[7 * 8..], &[16; 8]);
        assert!(out.u.iter().chain(&out.v).all(|&c| c == 128));
    }

    #[test]
    fn a_taller_frame_is_pillarboxed_and_same_shape_is_plain_resize() {
        let src = I420Frame {
            width: 2,
            height: 4,
            y: vec![235; 8],
            u: vec![128; 2],
            v: vec![128; 2],
        };
        let out = letterbox_i420(&src, 8, 4);
        // Offsets are even so chroma stays aligned: the picture sits at columns 2-3.
        assert_eq!(&out.y[..8], &[16, 16, 235, 235, 16, 16, 16, 16]);
        let same = letterbox_i420(&src, 4, 8);
        assert!(same.y.iter().all(|&y| y == 235));
    }

    #[test]
    fn nv12_with_padded_rows_splits_into_tight_planes() {
        // 4x2 frame, stride 6: Y rows then one interleaved UV row.
        let src = [
            1, 2, 3, 4, 0, 0, //
            5, 6, 7, 8, 0, 0, //
            10, 20, 11, 21, 0, 0,
        ];
        let stride = YuvLayout::Nv12.stride_for(src.len(), 4, 2).unwrap();
        assert_eq!(stride, 6);
        let frame = yuv_to_i420(&src, 4, 2, stride, YuvLayout::Nv12).unwrap();
        assert_eq!(frame.y, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(frame.u, vec![10, 11]);
        assert_eq!(frame.v, vec![20, 21]);
    }

    #[test]
    fn i420_buffer_planes_are_copied_in_order() {
        let src = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21];
        let stride = YuvLayout::I420.stride_for(src.len(), 4, 2).unwrap();
        let frame = yuv_to_i420(&src, 4, 2, stride, YuvLayout::I420).unwrap();
        assert_eq!(frame.y, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(frame.u, vec![10, 11]);
        assert_eq!(frame.v, vec![20, 21]);
    }

    #[test]
    fn yuy2_averages_chroma_over_row_pairs() {
        // 2x2: row 0 = Y0 U Y1 V, row 1 likewise.
        let src = [16, 100, 17, 200, 18, 110, 19, 210];
        let stride = YuvLayout::Yuy2.stride_for(src.len(), 2, 2).unwrap();
        let frame = yuv_to_i420(&src, 2, 2, stride, YuvLayout::Yuy2).unwrap();
        assert_eq!(frame.y, vec![16, 17, 18, 19]);
        assert_eq!(frame.u, vec![105]);
        assert_eq!(frame.v, vec![205]);
    }

    #[test]
    fn a_short_yuv_buffer_is_rejected() {
        assert!(yuv_to_i420(&[0; 10], 4, 2, 4, YuvLayout::Nv12).is_none());
        assert!(YuvLayout::Yuy2.stride_for(7, 2, 2).is_none());
    }

    #[test]
    fn i420_preview_conversion_preserves_neutral_black_and_white() {
        let black = I420Frame {
            width: 2,
            height: 2,
            y: vec![16; 4],
            u: vec![128],
            v: vec![128],
        };
        let white = I420Frame {
            width: 2,
            height: 2,
            y: vec![235; 4],
            u: vec![128],
            v: vec![128],
        };

        assert_eq!(i420_to_rgb(&black), vec![0; 12]);
        assert_eq!(i420_to_rgb(&white), vec![255; 12]);
    }

    #[test]
    fn filtered_downscale_averages_high_contrast_desktop_pixels() {
        let frame = I420Frame {
            width: 4,
            height: 4,
            y: vec![
                0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0,
            ],
            u: vec![128; 4],
            v: vec![128; 4],
        };
        let resized = resize_i420_filtered(&frame, 2, 2);
        assert_eq!(resized.y, vec![127; 4]);
    }

    #[test]
    fn filtered_upscale_interpolates_between_source_pixels() {
        let frame = I420Frame {
            width: 2,
            height: 2,
            y: vec![0, 100, 200, 255],
            u: vec![128],
            v: vec![128],
        };
        let resized = resize_i420_filtered(&frame, 3, 3);
        assert_eq!(resized.y[4], 139);
    }
}
