//! Same monochrome glyphs/rows as Electron's menuBarStatusImage. macOS colors
//! template images for the current appearance; no component palette is added.
pub fn bitmap(running: u64, review: u64, services: u64) -> Vec<u8> {
    const GLYPHS: [&str; 11] = [
        "111101101101111",
        "010110010010111",
        "111001111100111",
        "111001111001111",
        "101101111001001",
        "111100111001111",
        "111100111101111",
        "111001010010010",
        "111101111101111",
        "111101111001111",
        "000010111010000",
    ];
    let icons: [&[(usize, usize)]; 3] = [
        &[
            (0, 0),
            (0, 1),
            (1, 1),
            (0, 2),
            (1, 2),
            (2, 2),
            (3, 2),
            (0, 3),
            (1, 3),
            (0, 4),
        ],
        &[
            (2, 0),
            (1, 1),
            (3, 1),
            (0, 2),
            (4, 2),
            (1, 3),
            (3, 3),
            (2, 4),
        ],
        &[
            (0, 0),
            (1, 0),
            (3, 0),
            (4, 0),
            (1, 1),
            (3, 1),
            (2, 2),
            (2, 3),
            (1, 4),
            (2, 4),
            (3, 4),
        ],
    ];
    let rows = if services == 1 {
        vec![(0, running, 2), (1, review, 11)]
    } else {
        vec![(0, running, 0), (1, review, 6), (2, services, 12)]
    };
    let mut bytes = vec![0; 18 * 18 * 4];
    for (metric, count, y) in rows {
        let alpha = if count > 0 { 255 } else { 96 };
        for (x, dy) in icons[metric] {
            bytes[((y + dy) * 18 + x + 1) * 4 + 3] = alpha;
        }
        let glyph = GLYPHS[count.min(10) as usize];
        for (n, cell) in glyph.bytes().enumerate() {
            if cell == b'1' {
                bytes[((y + n / 3) * 18 + 11 + n % 3) * 4 + 3] = alpha;
            }
        }
    }
    bytes
}
