// Generates a 20x20 RGBA PNG Sankey icon for assets/icon.png
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const W = 20, H = 20;

// ── Pixel grid (RGBA) ─────────────────────────────────────────────────────────
const T    = [  0,   0,   0,   0];   // transparent
const NODE = [ 30, 120, 210, 255];   // solid blue  (#1e78d2)
const LINK = [ 30, 120, 210, 110];   // semi-transparent ribbon

const px = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => [...T])
);

function fill(r1, r2, c1, c2, color) {
    for (let r = r1; r <= r2; r++)
        for (let c = c1; c <= c2; c++)
            px[r][c] = [...color];
}

//  Layout (20x20):
//
//   cols  0-2   = left nodes (3 px wide)
//   cols  3-16  = ribbon area
//   cols 17-19  = right node (3 px wide)
//
//   Top-left node    : rows  1- 7
//   Bottom-left node : rows 11-17
//   Right node       : rows  4-14  (taller = merged flow)
//
//   Top ribbon       : rows  3- 5  (cols 3-16)
//   Bottom ribbon    : rows 13-15  (cols 3-16)
//   Merge band       : rows  5-15  (cols 12-16, where both ribbons overlap)

// Nodes
fill( 1,  7,  0,  2, NODE);   // left-top
fill(11, 17,  0,  2, NODE);   // left-bottom
fill( 4, 14, 17, 19, NODE);   // right (merged)

// Ribbons
fill( 3,  5,  3, 16, LINK);   // top ribbon
fill(13, 15,  3, 16, LINK);   // bottom ribbon

// Converging centre band (both ribbons visible together)
fill( 5, 13, 13, 16, LINK);

// ── PNG encoding ─────────────────────────────────────────────────────────────

// CRC-32 table
const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const typeB  = Buffer.from(type, 'ascii');
    const lenB   = Buffer.alloc(4);  lenB.writeUInt32BE(data.length, 0);
    const crcVal = crc32(Buffer.concat([typeB, data]));
    const crcB   = Buffer.alloc(4);  crcB.writeUInt32BE(crcVal, 0);
    return Buffer.concat([lenB, typeB, data, crcB]);
}

// Scanlines: filter-byte(0) + RGBA pixels per row
const raw = Buffer.alloc(H * (1 + W * 4));
let offset = 0;
for (let r = 0; r < H; r++) {
    raw[offset++] = 0; // filter: None
    for (let c = 0; c < W; c++) {
        raw[offset++] = px[r][c][0];
        raw[offset++] = px[r][c][1];
        raw[offset++] = px[r][c][2];
        raw[offset++] = px[r][c][3];
    }
}

const compressed = zlib.deflateSync(raw, { level: 9 });

// IHDR: 20x20, 8-bit RGBA (color type 6)
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log(`icon.png written (${png.length} bytes)`);
