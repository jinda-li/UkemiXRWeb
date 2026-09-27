// Turns a public superspl.at scene into a streamed web sample:
//
//   node scripts/importSuperSplat.mjs <sceneId> <lod> <outDir> [name]
//   e.g. node scripts/importSuperSplat.mjs 14bac5b2 2 SplatSamples/trogir trogir
//
//   1. merge one LOD level from the public CDN into a PLY (splat-transform)
//   2. build Spark's LoD tree and write it as a chunked .rad (build-lod)
//   3. convert the scene's walk-mode voxels into a gzipped walk grid
//
// Needs Rust for build-lod. Set BUILD_LOD to its binary, or let the script
// clone Spark into scratch/ and build it (a few minutes, once). Big
// intermediates go to scratch/<name>/. Check the scene's licence and put the
// credit in src/samples.js.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const [sceneId, lodArg, outDirArg, nameArg] = process.argv.slice(2);
if (!outDirArg) {
  console.error('usage: node scripts/importSuperSplat.mjs <sceneId> <lod> <outDir> [name]');
  process.exit(1);
}
const lod = Number(lodArg);
const name = nameArg || sceneId;
const web = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(outDirArg);
const work = path.join(web, 'scratch', name);
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const CDN = `https://d28zzqy0iyovbz.cloudfront.net/${sceneId}/v1`;
const S3 = `https://s3-eu-west-1.amazonaws.com/splats.playcanvas.com/${sceneId}/v1`;
const win = process.platform === 'win32';
const run = (cmd, args, opts = {}) => {
  console.log(`> ${cmd} ${args.join(' ')}`.slice(0, 300));
  execFileSync(cmd, args, { stdio: 'inherit', shell: win, ...opts });
};

async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // fetch undoes Content-Encoding: gzip, so this is the raw file.
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// 1. One LOD level is a complete scene, split into spatial chunks.
const lodMeta = await (await fetch(`${CDN}/lod-meta.json`)).json();
const chunks = lodMeta.filenames.filter((f) => f.startsWith(`${lod}_`));
console.log(`LOD ${lod}: ${lodMeta.counts[lod].toLocaleString()} splats in ${chunks.length} chunks`);
const ply = path.join(work, `${name}_lod${lod}.ply`);
if (!fs.existsSync(ply)) run('npx', ['-y', '@playcanvas/splat-transform', ...chunks.map((c) => `${CDN}/${c}`), '-N', ply]);

// 2. LoD tree -> chunked RAD, streamed by Spark with paged: true.
let buildLod = process.env.BUILD_LOD;
if (!buildLod) {
  const src = path.join(web, 'scratch', 'spark-src');
  if (!fs.existsSync(src)) run('git', ['clone', '--depth', '1', 'https://github.com/sparkjsdev/spark.git', src]);
  buildLod = path.join(src, 'rust', 'target', 'release', win ? 'build-lod.exe' : 'build-lod');
  if (!fs.existsSync(buildLod)) run('cargo', ['build', '--release', '--manifest-path', path.join(src, 'rust', 'build-lod', 'Cargo.toml')]);
}
const before = new Set(fs.readdirSync(work));
run(buildLod, ['--quality', '--max-sh=0', '--rad-chunked', ply]);
// <ply name>-lod.rad is the index; it names its <ply name>-lod-<n>.radc chunks,
// so the files keep the names build-lod gave them.
for (const f of fs.readdirSync(work)) {
  if (!before.has(f) && /\.radc?$/.test(f)) fs.renameSync(path.join(work, f), path.join(outDir, f));
}

// 3. Collision: the voxels superspl.at's own walk mode uses.
const vjson = path.join(work, 'scene.voxel.json'), vbin = path.join(work, 'scene.voxel.bin');
await download(`${S3}/scene.voxel.json`, vjson);
await download(`${S3}/scene.voxel.bin`, vbin);
await download(`${S3}/settings.json`, path.join(work, 'settings.json'));
const grid = path.join(work, `${name}.walk.bin`);
run('node', [path.join(web, 'scripts', 'voxelToWalkGrid.mjs'), vjson, vbin, grid]);
fs.writeFileSync(path.join(outDir, `${name}.walk.bin.gz`), zlib.gzipSync(fs.readFileSync(grid), { level: 9 }));

const cam = JSON.parse(fs.readFileSync(path.join(work, 'settings.json'), 'utf8')).cameras?.[0]?.initial;
if (cam) {
  const [px, , pz] = cam.position, [tx, , tz] = cam.target;
  const yaw = Math.atan2(-(tx - px), -(tz - pz));
  console.log(`spawn for src/samples.js: { x: ${px.toFixed(2)}, z: ${pz.toFixed(2)}, yaw: ${yaw.toFixed(2)} }`);
}
console.log(`done -> ${outDir}`);
