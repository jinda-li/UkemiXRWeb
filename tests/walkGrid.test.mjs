// Prebaked walk grids (src/collision/walkGrid.js): a synthetic round trip,
// then, if the Trogir sample has been built (scripts/importSuperSplat.mjs),
// a walk along the streets Unity's TrogirWalkProbe uses.
// Run: node tests/walkGrid.test.mjs

import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodeWalkGrid, BRICK } from '../src/collision/walkGrid.js';
import { VoxelWorld } from '../src/collision/VoxelWorld.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// 1. Synthetic: a 4 m x 4 m floor with a wall across x = 2, in 0.1 m voxels.
{
  const dims = [40, 30, 40], bricks = new Map();
  const nb = dims.map((d) => Math.ceil(d / BRICK));
  const set = (x, y, z) => {
    const id = ((y >> 3) * nb[2] + (z >> 3)) * nb[0] + (x >> 3);
    if (!bricks.has(id)) bricks.set(id, new Uint32Array(BRICK ** 3 / 32));
    const bit = ((y & 7) * 8 + (z & 7)) * 8 + (x & 7);
    bricks.get(id)[bit >>> 5] |= 1 << (bit & 31);
  };
  for (let z = 0; z < 40; ++z) for (let x = 0; x < 40; ++x) for (let y = 0; y < 10; ++y) set(x, y, z);
  for (let z = 0; z < 40; ++z) for (let y = 10; y < 30; ++y) set(20, y, z);
  const w = VoxelWorld.fromWalkGrid(toArrayBuffer(encodeWalkGrid({ voxel: 0.1, origin: [-2, -1, -2], dims, bricks })));
  check('floor and wall survive the round trip', w.solidAt(-1, -0.05, 0) && w.solidAt(0.05, 0.5, 0) && !w.solidAt(-1, 0.5, 0));
  const sp = w.findSpawn(-1, 0, 1);
  check('spawn stands on the floor top', sp.ok && Math.abs(sp.y) < 1e-6, `y ${sp.y.toFixed(3)}`);
  const pos = { x: -1, y: sp.y, z: 0 };
  for (let i = 0; i < 120; ++i) w.moveAndSlide(pos, 2.5 / 60, 0);
  check('the wall stops the body', pos.x < 0 && pos.x > -0.5, `x ${pos.x.toFixed(2)}`);
}

// 2. Trogir, when built.
const trogir = fileURLToPath(new URL('../SplatSamples/trogir/trogir.walk.bin.gz', import.meta.url));
if (!fs.existsSync(trogir)) {
  console.log('skip  Trogir walk grid not built (node scripts/importSuperSplat.mjs 14bac5b2 2 SplatSamples/trogir trogir)');
} else {
  const w = VoxelWorld.fromWalkGrid(toArrayBuffer(zlib.gunzipSync(fs.readFileSync(trogir))));
  const sp = w.findSpawn(14.77, 42.51, 3);
  check('Trogir spawn is on the street', sp.ok && Math.abs(sp.y + 0.4) < 0.3, `(${sp.x.toFixed(2)}, ${sp.y.toFixed(2)}, ${sp.z.toFixed(2)})`);
  // Along the alleys (engine frame, same numbers as the Unity scene).
  const route = [[18.0, 44.2], [22.0, 46.2], [18.0, 44.2], [15.0, 44.8], [14.5, 46.0], [14.3, 47.0], [13.5, 49.0], [13.1, 51.0], [12.8, 52.0]];
  const pos = { x: sp.x, y: sp.y, z: sp.z };
  let worst = 0, minY = pos.y, maxY = pos.y;
  for (const [x, z] of route) {
    for (let f = 0; f < 60 * 20; ++f) {
      const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz);
      if (d < 0.25) break;
      const s = Math.min(d, 2.5 / 60);
      w.moveAndSlide(pos, (dx / d) * s, (dz / d) * s);
      minY = Math.min(minY, pos.y); maxY = Math.max(maxY, pos.y);
    }
    worst = Math.max(worst, Math.hypot(x - pos.x, z - pos.z));
  }
  check('the alley route is walkable end to end', worst < 0.4, `worst miss ${worst.toFixed(2)} m, feet ${minY.toFixed(2)}..${maxY.toFixed(2)}`);
  const inside = { x: 17.0, y: sp.y, z: 46.5 }; // inside the block north of the alley
  check('a building is not standable from the street', Number.isNaN(w._standAt(inside.x, inside.z, sp.y)));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
