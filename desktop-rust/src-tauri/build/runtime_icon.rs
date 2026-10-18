//! Tauri codegen's PNG reader preserves 16-bit samples, while Tao expects
//! exactly width * height * 4 bytes. Convert only the Preview runtime input.
use std::{fs, io::Cursor, path::Path};

pub fn rgba8(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::STRIP_16 | png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err("Icon conversion did not yield 8-bit samples".into());
    }
    let data = &buffer[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => data
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|v| [*v, *v, *v, 255]).collect(),
        png::ColorType::Indexed => return Err("Icon palette was not expanded".into()),
    };
    let expected = (info.width as usize)
        .checked_mul(info.height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("Icon dimensions overflow")?;
    if expected == 0 || rgba.len() != expected {
        return Err("Invalid runtime icon pixel length".into());
    }
    Ok((info.width, info.height, rgba))
}

pub fn generate(input: &Path, output: &Path) -> Result<(), String> {
    let (width, height, pixels) = rgba8(&fs::read(input).map_err(|e| e.to_string())?)?;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(&pixels)
            .map_err(|e| e.to_string())?;
    }
    if fs::read(output).ok().as_deref() == Some(&bytes) {
        return Ok(());
    }
    fs::create_dir_all(output.parent().ok_or("Missing icon output directory")?)
        .map_err(|e| e.to_string())?;
    fs::write(output, bytes).map_err(|e| e.to_string())
}
