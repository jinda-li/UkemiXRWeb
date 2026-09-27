// Converts a splat-transform voxel octree (.voxel.json + .voxel.bin, the
// format superspl.at's walk mode uses) into the sparse brick grid that
// VoxelWorld.fromBricks() loads (see src/collision/walkGrid.js for the layout).
//
//   node scripts/voxelToWalkGrid.mjs <scene.voxel.json> <scene.voxel.bin> <out.walk.bin> [voxelSize=0.1]
//
// The .bin may be gzip-compressed (S3 serves it that way). Voxels are
// downsampled by OR: a coarse voxel is solid if any fine voxel in it is.
// Coordinates stay in the file's frame (PlayCanvas engine frame for
// splat-transform output), so the splats have to be shown in the same frame.
// Format spec: https://developer.playcanvas.com/user-manual/splat-transform/voxel-format/

import fs from 'node:fs';
import zlib from 'node:zlib';
import { encodeWalkGrid, BRICK } from '../src/collision/walkGrid.js';

const [jsonPath, binPath, outPath, sizeArg] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node scripts/voxelToWalkGrid.mjs <scene.voxel.json> <scene.voxel.bin> <out.walk.bin> [voxelSize=0.1]');
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let raw = fs.readFileSync(binPath);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
const words = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
if (words.length !== meta.nodeCount + meta.leafDataCount) throw new Error(`bin has ${words.length} words, expected ${meta.nodeCount + meta.leafDataCount}`);
const nodes = words.subarray(0, meta.nodeCount);
const leafData = words.subarray(meta.nodeCount);

const res = meta.voxelResolution;
const voxel = Number(sizeArg || 0.1);
const factor = Math.round(voxel / res);
if (factor < 1 || Math.abs(factor * res - voxel) > 1e-6) throw new Error(`voxel size ${voxel} must be a multiple of ${res}`);

const min = meta.gridBounds.min, max = meta.gridBounds.max;
const nx = Math.ceil((max[0] - min[0]) / voxel - 1e-6);
const ny = Math.ceil((max[1] - min[1]) / voxel - 1e-6);
const nz = Math.ceil((max[2] - min[2]) / voxel - 1e-6);
const nbx = Math.ceil(nx / BRICK), nby = Math.ceil(ny / BRICK), nbz = Math.ceil(nz / BRICK);
const bricks = new Map(); // brick index -> Uint32Array(BRICK^3 / 32)

function setSolid(ix, iy, iz) {
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
  const b = ((iy >> 3) * nbz + (iz >> 3)) * nbx + (ix >> 3);
  let bits = bricks.get(b);
  if (!bits) bricks.set(b, (bits = new Uint32Array(BRICK ** 3 / 32)));
  const bit = ((iy & 7) * BRICK + (iz & 7)) * BRICK + (ix & 7);
  bits[bit >>> 5] |= 1 << (bit & 31);
}

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Walk the octree. A node at depth d spans 2^(treeDepth-d) leaf blocks of
// 4^3 fine voxels per axis; (bx, by, bz) is its first block.
function visit(node, depth, bx, by, bz) {
  const word = nodes[node];
  const span = 1 << (meta.treeDepth - depth); // in blocks
  if (word === 0xff000000) {
    const v0 = [bx * 4, by * 4, bz * 4], n = span * 4;
    for (let y = Math.floor(v0[1] / factor); y < Math.ceil((v0[1] + n) / factor); ++y)
      for (let z = Math.floor(v0[2] / factor); z < Math.ceil((v0[2] + n) / factor); ++z)
        for (let x = Math.floor(v0[0] / factor); x < Math.ceil((v0[0] + n) / factor); ++x) setSolid(x, y, z);
    return;
  }
  if (word >>> 24 === 0) {
    const lo = leafData[2 * word], hi = leafData[2 * word + 1];
    for (let bit = 0; bit < 64; ++bit) {
      if (!(bit < 32 ? (lo >>> bit) & 1 : (hi >>> (bit - 32)) & 1)) continue;
      const lx = bit & 3, ly = (bit >> 2) & 3, lz = bit >> 4;
      setSolid(Math.floor((bx * 4 + lx) / factor), Math.floor((by * 4 + ly) / factor), Math.floor((bz * 4 + lz) / factor));
    }
    return;
  }
  const mask = word >>> 24, first = word & 0xffffff, half = span >> 1;
  for (let oct = 0; oct < 8; ++oct) {
    if (!(mask & (1 << oct))) continue;
    const child = first + popcount(mask & ((1 << oct) - 1));
    visit(child, depth + 1, bx + (oct & 1) * half, by + ((oct >> 1) & 1) * half, bz + ((oct >> 2) & 1) * half);
  }
}

const t0 = Date.now();
visit(0, 0, 0, 0, 0);
const out = encodeWalkGrid({ voxel, origin: min, dims: [nx, ny, nz], bricks });
fs.writeFileSync(outPath, out);
console.log(`${nx}x${ny}x${nz} voxels of ${voxel} m, ${bricks.size} bricks, ${(out.length / 1048576).toFixed(1)} MB, ${Date.now() - t0} ms -> ${outPath}`);
