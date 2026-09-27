// Uploads a streamed scene folder to a Cloudflare R2 bucket with wrangler.
//
//   npx wrangler login                                  (once)
//   node scripts/uploadScene.mjs <bucket> SplatSamples/trogir
//
// Objects land at <bucket>/<folder name>/<file>, which is what src/samples.js
// asks for under VITE_SCENE_CDN. If an upload stops part way, re-run with
// SKIP=<n> to carry on after the first n files.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [bucket, dirArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/uploadScene.mjs <bucket> <scene folder>');
  process.exit(1);
}
const dir = path.resolve(dirArg);
const prefix = path.basename(dir);
const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
const skip = Number(process.env.SKIP || 0);
files.forEach((f, i) => {
  if (i < skip) return;
  console.log(`[${i + 1}/${files.length}] ${prefix}/${f}`);
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${prefix}/${f}`,
    '--file', path.join(dir, f),
    '--content-type', 'application/octet-stream',
    '--cache-control', 'public, max-age=86400',
    '--remote'], { stdio: 'inherit', shell: process.platform === 'win32' });
});
