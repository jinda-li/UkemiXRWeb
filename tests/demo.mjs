// The hands-free comfort demo (?demo): the avatar walks on its own, the camera
// alternates 5 s steady cuts (UkemiXR ON) / 5 s first-person follow (OFF), and
// the banner says which one is running.
//   BASE=http://127.0.0.1:5173 node tests/demo.mjs [scene]
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const scene = process.argv[2] || 'living-room';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/?scene=${scene}&demo&norender&test`);
await page.waitForFunction(() => window.ukemi?.world && window.ukemi.mode === 'walk', null, { timeout: 180000 });

// Fixed-step simulation of 40 s (four ON/OFF cycles).
const r = await page.evaluate(() => {
  const u = window.ukemi, T = u.THREE;
  u.pause();
  const frames = [];
  const c = new T.Vector3(), h = new T.Vector3();
  for (let i = 0; i < 60 * 40; ++i) {
    u.step(1 / 60);
    u.camera.getWorldPosition(c);
    u.player.avatarHead(h);
    frames.push({
      phase: u.demo.phaseIndex, follow: u.cameraRig.followMode, loco: u.player.isLocomoting,
      speed: u.player.speed, visible: u.avatar.root.visible, off: c.distanceTo(h),
      cam: c.toArray(), yaw: u.cameraRig.hmdYaw(),
      banner: document.getElementById('demo-state').textContent,
      bannerShown: !document.getElementById('demo-banner').hidden,
    });
  }
  u.resume();
  return frames;
});

const phases = [];
for (const f of r) if (phases.at(-1)?.phase !== f.phase) phases.push({ phase: f.phase, n: 0 }); else phases.at(-1).n++;
check('phases alternate every 5 s', phases.length >= 7 && phases.slice(1, -1).every((p) => Math.abs(p.n + 1 - 300) <= 2),
  phases.map((p) => `${p.phase}:${p.n + 1}`).join(' '));
check('banner shows ON in steady cuts and OFF in first person',
  r.every((f) => f.bannerShown && f.banner === (f.phase === 0 ? 'ON' : 'OFF') && f.follow === (f.phase === 0 ? 'discrete' : 'firstPerson')));
const loco = r.filter((f) => f.loco);
const stuck = loco.filter((f) => f.speed < 0.25).length / Math.max(1, loco.length);
check('avatar walks by itself most of the time', loco.length > r.length * 0.85 && stuck < 0.15,
  `${((100 * loco.length) / r.length).toFixed(0)}% walking, ${(100 * stuck).toFixed(0)}% of it blocked`);

const on = r.filter((f) => f.phase === 0 && f.loco);
const offF = r.filter((f) => f.phase === 1 && f.loco);
check('ON: avatar visible, third person', on.every((f) => f.visible));
check('OFF: avatar hidden, view in the head', offF.every((f) => !f.visible) && Math.max(...offF.slice(5).map((f) => f.off)) < 0.05,
  `max offset ${Math.max(...offF.slice(5).map((f) => f.off)).toFixed(3)} m`);

// ON never rotates the view continuously and moves only in cuts; OFF turns
// and moves every frame.
const moves = (list) => {
  let moved = 0, turned = 0;
  for (let i = 1; i < list.length; ++i) {
    const a = list[i - 1], b = list[i];
    if (Math.hypot(a.cam[0] - b.cam[0], a.cam[2] - b.cam[2]) > 1e-4) moved++;
    const d = Math.abs(Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)));
    if (d > 1e-4 && d < 0.3) turned++; // small = smooth turn; snaps are 35°
  }
  return { moved: moved / list.length, turned: turned / list.length };
};
const mOn = moves(on), mOff = moves(offF);
check('ON: camera still between cuts, no smooth turning', mOn.moved < 0.1 && mOn.turned === 0,
  `moves on ${(100 * mOn.moved).toFixed(0)}% of frames, smooth turns ${(100 * mOn.turned).toFixed(0)}%`);
check('OFF: camera moves and turns continuously', mOff.moved > 0.6 && mOff.turned > 0.05,
  `moves on ${(100 * mOff.moved).toFixed(0)}% of frames, smooth turns ${(100 * mOff.turned).toFixed(0)}%`);

await page.evaluate(() => window.ukemi.stopDemo());
const after = await page.evaluate(() => ({ active: window.ukemi.demo.active, banner: document.getElementById('demo-banner').hidden, follow: window.ukemi.cameraRig.followMode }));
check('stopping the demo hides the banner and restores the setting', !after.active && after.banner && after.follow === 'discrete');
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
