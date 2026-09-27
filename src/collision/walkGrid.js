// Prebaked collision for scenes too big to voxelise in the browser.
//
// A city-sized capture at 0.1 m is ~400 M voxels, almost all of them air, so
// the grid is stored as 8x8x8 bricks and only bricks with something solid in
// them are kept. scripts/voxelToWalkGrid.mjs writes it; VoxelWorld.fromWalkGrid
// reads it.
//
// Layout (little-endian):
//   0   'UKWG'                      magic
//   4   u32 version = 1
//   8   f32 voxel size (m)
//   12  f32 x3 origin (min corner)
//   24  u32 x3 dims in voxels (nx, ny, nz)
//   36  u32 brick edge in voxels (= BRICK)
//   40  u32 mixed brick count (B)
//   44  u32 full brick count (F)
//   48  u32 x B  mixed brick ids, ascending; id = (by * nbz + bz) * nbx + bx
//   ..  u32 x F  ids of bricks that are solid all through (no bits stored)
//   ..  u32 x B*16  one solid bit per voxel, bit = (ly * 8 + lz) * 8 + lx
//
// Most bricks of a splat-transform grid are full: it fills everything the
// flood fill from the seed cannot reach (the ground, building interiors).

export const BRICK = 8;
const WORDS = BRICK ** 3 / 32;
const MAGIC = 0x47574b55; // 'UKWG'
export const EMPTY_BRICK = -1;
export const FULL_BRICK = -2;

export function encodeWalkGrid({ voxel, origin, dims, bricks }) {
  const all = [...bricks.keys()].sort((a, b) => a - b);
  const isFull = (id) => bricks.get(id).every((w) => w === 0xffffffff);
  const ids = all.filter((id) => !isFull(id));
  const full = all.filter(isFull);
  const buf = new ArrayBuffer(48 + (ids.length + full.length) * 4 + ids.length * 4 * WORDS);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setFloat32(8, voxel, true);
  origin.forEach((v, i) => dv.setFloat32(12 + i * 4, v, true));
  dims.forEach((v, i) => dv.setUint32(24 + i * 4, v, true));
  dv.setUint32(36, BRICK, true);
  dv.setUint32(40, ids.length, true);
  dv.setUint32(44, full.length, true);
  const idArr = new Uint32Array(buf, 48, ids.length);
  new Uint32Array(buf, 48 + ids.length * 4, full.length).set(full);
  const bits = new Uint32Array(buf, 48 + (ids.length + full.length) * 4, ids.length * WORDS);
  ids.forEach((id, i) => {
    idArr[i] = id;
    bits.set(bricks.get(id), i * WORDS);
  });
  return new Uint8Array(buf);
}

export function decodeWalkGrid(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a walk grid file');
  if (dv.getUint32(4, true) !== 1) throw new Error('Unsupported walk grid version');
  if (dv.getUint32(36, true) !== BRICK) throw new Error('Unsupported brick size');
  const voxel = dv.getFloat32(8, true);
  const origin = [0, 1, 2].map((i) => dv.getFloat32(12 + i * 4, true));
  const [nx, ny, nz] = [0, 1, 2].map((i) => dv.getUint32(24 + i * 4, true));
  const count = dv.getUint32(40, true);
  const fullCount = dv.getUint32(44, true);
  const nbx = Math.ceil(nx / BRICK), nby = Math.ceil(ny / BRICK), nbz = Math.ceil(nz / BRICK);
  const ids = new Uint32Array(arrayBuffer, 48, count);
  const full = new Uint32Array(arrayBuffer, 48 + count * 4, fullCount);
  const bits = new Uint32Array(arrayBuffer, 48 + (count + fullCount) * 4, count * WORDS);
  // Per brick: offset of its bits, EMPTY_BRICK or FULL_BRICK.
  const brickIndex = new Int32Array(nbx * nby * nbz).fill(EMPTY_BRICK);
  for (let i = 0; i < count; ++i) brickIndex[ids[i]] = i * WORDS;
  for (let i = 0; i < fullCount; ++i) brickIndex[full[i]] = FULL_BRICK;
  return { voxel, origin, dims: [nx, ny, nz], nb: [nbx, nby, nbz], brickIndex, bits, count, fullCount };
}
