'use strict';

// Génère les icônes PNG de la PWA (lune et viseur sur fond de nuit) sans dépendance.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BG = [11, 9, 16];
const MOON = [244, 228, 193];
const PUMPKIN = [255, 122, 26];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Couleur au pixel (x, y) en coordonnées centrées [-1, 1] : viseur citrouille sur un croissant de lune.
function paint(x, y) {
  const d = Math.hypot(x, y);
  const ring = Math.abs(d - 0.56) < 0.04;
  const tick = (Math.abs(x) < 0.035 || Math.abs(y) < 0.035) && d > 0.46 && d < 0.76;
  if (ring || tick || d < 0.05) return PUMPKIN;
  const moon = d < 0.38 && Math.hypot(x - 0.27, y + 0.2) > 0.33;
  return moon ? MOON : BG;
}

function render(size) {
  const SS = 3;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = paint(x, y);
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(sum[i] / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [file, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  fs.writeFileSync(path.join(OUT, file), render(size));
  console.log('écrit', file);
}
