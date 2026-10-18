#[path = "../build/runtime_icon.rs"]
mod runtime_icon;
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::Path};
#[test]
fn actual_16bit_pwa_icon_becomes_exact_rgba8_without_changing_stable_asset() {
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/pwa-512x512.png");
    let original = fs::read(&input).unwrap();
    let digest = Sha256::digest(&original);
    let mut original_reader = png::Decoder::new(Cursor::new(&original))
        .read_info()
        .unwrap();
    assert_eq!(original_reader.info().bit_depth, png::BitDepth::Sixteen);
    assert_eq!(original_reader.info().color_type, png::ColorType::Rgba);
    let mut raw = vec![0; original_reader.output_buffer_size()];
    let original_frame = original_reader.next_frame(&mut raw).unwrap();
    assert_eq!(original_frame.buffer_size(), 512 * 512 * 8);
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("icon.png");
    runtime_icon::generate(&input, &output).unwrap();
    let encoded = fs::read(&output).unwrap();
    let mut reader = png::Decoder::new(Cursor::new(&encoded))
        .read_info()
        .unwrap();
    assert_eq!(reader.info().bit_depth, png::BitDepth::Eight);
    assert_eq!(reader.info().color_type, png::ColorType::Rgba);
    let mut pixels = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut pixels).unwrap();
    assert_eq!((frame.width, frame.height), (512, 512));
    assert_eq!(
        frame.buffer_size(),
        frame.width as usize * frame.height as usize * 4
    );
    // Strip_16 preserves the high byte of every channel, including alpha.
    assert!(pixels
        .iter()
        .zip(raw.chunks_exact(2))
        .all(|(actual, sample)| *actual == sample[0]));
    assert_eq!(Sha256::digest(fs::read(input).unwrap()), digest);
    assert!(runtime_icon::rgba8(b"invalid PNG").is_err());
}
