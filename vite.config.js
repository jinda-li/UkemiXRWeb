import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Web/SplatSamples holds the sample captures. Serve it at /samples in dev and
// copy everything but the .ply files into the build (the .ply twins are 34 MB
// each and are the same scenes as the .spz, so they stay out of the
// deployment). Subfolders hold streamed scenes: a .rad index, its chunks and
// the prebaked collision. With VITE_SCENE_CDN set those are served from object
// storage instead and stay out of the build too.
const samplesDir = path.resolve(import.meta.dirname, 'SplatSamples');

function samples(sceneCdn) {
  return {
    name: 'ukemixr-samples',
    configureServer(server) {
      server.middlewares.use('/samples', (req, res, next) => {
        const file = path.join(samplesDir, decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(samplesDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Length', fs.statSync(file).size);
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const out = path.resolve(import.meta.dirname, 'dist/samples');
      const streamed = (src) => src !== samplesDir && (path.dirname(src) !== samplesDir || fs.statSync(src).isDirectory());
      fs.cpSync(samplesDir, out, { recursive: true, filter: (src) => !src.endsWith('.ply') && !(sceneCdn && streamed(src)) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [samples(loadEnv(mode, import.meta.dirname, 'VITE_').VITE_SCENE_CDN)],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { host: '127.0.0.1', port: 5173 },
}));
