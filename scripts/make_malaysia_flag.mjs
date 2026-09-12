// Render the Malaysian flag (Jalur Gemilang) as a PNG, matching the 320px-wide
// convention of the other flags in gs://f1-scratch-assets/flags/.
// No image deps: rasterise by hand, deflate with node's zlib, emit the PNG
// chunks directly.
import zlib from 'node:zlib';
import fs from 'node:fs';

const W = 320, H = 160;          // official ratio 1:2
const SS = 4;                    // supersampling factor per axis

const RED = [0xcc, 0x00, 0x01];
const WHITE = [0xff, 0xff, 0xff];
const BLUE = [0x01, 0x00, 0x66];
const YELLOW = [0xff, 0xcc, 0x00];

const STRIPE = H / 14;           // 14 stripes, red first and last
const CANTON_W = W / 2;
const CANTON_H = STRIPE * 8;     // canton covers the first 8 stripes

// Crescent: a disc with a second disc cut out of it, opening to the right.
const CR = { x: 60, y: CANTON_H / 2, r: 28.5 };
const CUT = { x: 71.5, y: CANTON_H / 2, r: 23.5 };
// 14-pointed star ("Bintang Persekutuan"), sitting in the crescent's opening.
const STAR = { x: 100, y: CANTON_H / 2, outer: 16.5, inner: 9.2, points: 14 };

// Star as a 28-vertex polygon, first point aimed up.
const starPoly = [];
for (let i = 0; i < STAR.points * 2; i++) {
  const r = i % 2 === 0 ? STAR.outer : STAR.inner;
  const a = -Math.PI / 2 + (i * Math.PI) / STAR.points;
  starPoly.push([STAR.x + r * Math.cos(a), STAR.y + r * Math.sin(a)]);
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const dist2 = (x, y, c) => (x - c.x) ** 2 + (y - c.y) ** 2;

/** Colour of a single sample point, before averaging. */
function sample(x, y) {
  if (x < CANTON_W && y < CANTON_H) {
    const inCrescent = dist2(x, y, CR) <= CR.r ** 2 && dist2(x, y, CUT) > CUT.r ** 2;
    if (inCrescent || inPolygon(x, y, starPoly)) return YELLOW;
    return BLUE;
  }
  // Stripe 0 is red, and they alternate from there.
  return Math.floor(y / STRIPE) % 2 === 0 ? RED : WHITE;
}

const raw = Buffer.alloc(H * (1 + W * 3));
for (let py = 0; py < H; py++) {
  const row = py * (1 + W * 3);
  raw[row] = 0; // filter type 0 (None)
  for (let px = 0; px < W; px++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        r += c[0]; g += c[1]; b += c[2];
      }
    }
    const n = SS * SS;
    const o = row + 1 + px * 3;
    raw[o] = Math.round(r / n);
    raw[o + 1] = Math.round(g / n);
    raw[o + 2] = Math.round(b / n);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type 2 = truecolour RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || 'Malaysia.png';
fs.writeFileSync(out, png);
console.log(`${out} ${W}x${H} ${png.length}B`);
