// Sample scenes, served from Web/SplatSamples at /samples (see vite.config.js).
// The PLY twins are the same captures uncompressed (34 MB each) and are only
// listed in dev; the deployed site ships the SPZ files. `upright` marks files
// known to be +Y up (Marble exports), which skips the which-way-up check.

// Streamed scenes (hundreds of MB of chunks) are too big to ship inside the
// site. In production they live in object storage: set VITE_SCENE_CDN to its
// public URL (e.g. https://scenes.example.com, a Cloudflare R2 bucket with a
// custom domain and CORS open to the site). Unset, they come from
// SplatSamples like the other samples.
const STREAMED = (import.meta.env.VITE_SCENE_CDN || '/samples').replace(/\/+$/, '');

export const SAMPLES = [
  {
    id: 'living-room',
    name: 'Cozy living room',
    kind: 'Residential interior',
    sub: 'A furnished apartment. Walk around the sofa, the coffee table and the armchairs.',
    tags: ['Real estate', 'Interior'],
    thumb: '/thumbs/living-room.jpg',
    url: '/samples/project-cozy-living-room-interior.spz',
    upright: true,
  },
  {
    id: 'bamboo-courtyard',
    name: 'Bamboo courtyard',
    kind: 'Heritage garden',
    sub: 'A traditional courtyard with stone paths, a still pool and bamboo groves.',
    tags: ['Hospitality', 'Heritage', 'Outdoor'],
    thumb: '/thumbs/bamboo-courtyard.jpg',
    url: '/samples/project-ancient-chinese-bamboo-courtyard.spz',
    upright: true,
  },
  // A whole town, 5.8 M splats: too big to download up front or to
  // voxelise in the browser. It streams as a Spark LoD tree (.rad, paged in
  // around the viewer) and ships superspl.at's own walk-mode voxels as its
  // collision. Built by scripts/importSuperSplat.mjs; CC BY 4.0, the credit
  // has to stay visible.
  {
    id: 'trogir',
    name: 'Trogir old town',
    kind: 'UNESCO old town, Croatia',
    sub: 'A whole medieval town: stone alleys, squares and the cathedral, streamed as you walk.',
    tags: ['Tourism', 'Heritage', 'City scale'],
    thumb: '/thumbs/trogir.jpg',
    url: `${STREAMED}/trogir/trogir_lod2-lod.rad`,
    paged: true,
    collision: `${STREAMED}/trogir/trogir.walk.bin.gz`,
    frame: 'playcanvas',
    spawn: { x: 14.77, z: 42.51, yaw: -2.30 },
    credit: 'Capture by Paolo Tosolini, CC BY 4.0',
  },
  ...(import.meta.env.DEV
    ? [
        { id: 'living-room-ply', name: 'Cozy living room (PLY)', dev: true, url: '/samples/project-cozy-living-room-interior.ply', upright: true },
        { id: 'bamboo-courtyard-ply', name: 'Bamboo courtyard (PLY)', dev: true, url: '/samples/project-ancient-chinese-bamboo-courtyard.ply', upright: true },
      ]
    : []),
];
