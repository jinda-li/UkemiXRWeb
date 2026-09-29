// The auto demo (?demo): the avatar walks a fixed route on its own, the camera
// alternates 8 s steady cuts (UkemiXR ON) / 5 s first-person follow (OFF), each
// run starting back at the spawn, and the banner says which one is running.
// Any key hands control to the visitor; 10 s idle plays the demo again.
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
let spawnXZ;
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
      cam: c.toArray(), yaw: u.cameraRig.hmdYaw(), body: [u.player.body.x, u.player.body.z],
      fade: u.fade, card: u.card,
      banner: document.getElementById('demo-state').textContent,
      bannerText: document.getElementById('demo-banner').textContent.replace(/\s+/g, ' ').trim(),
      bannerShown: !document.getElementById('demo-banner').hidden,
    });
  }
  u.resume();
  return { frames, spawn: [u.spawn.x, u.spawn.z] };
}).then((x) => { spawnXZ = x.spawn; return x.frames; });

const phases = [];
for (const f of r) if (phases.at(-1)?.phase !== f.phase) phases.push({ phase: f.phase, n: 0 }); else phases.at(-1).n++;
check('ON lasts 8 s, OFF 5 s', phases.length >= 6 && phases.slice(1, -1).every((p) => Math.abs(p.n + 1 - (p.phase === 0 ? 480 : 300)) <= 2),
  phases.map((p) => `${p.phase}:${p.n + 1}`).join(' '));
check('banner shows ON in steady cuts and OFF in first person',
  r.every((f) => f.bannerShown && f.banner === (f.phase === 0 ? 'ON' : 'OFF') && f.follow === (f.phase === 0 ? 'discrete' : 'firstPerson')));
check('banner says only ON / OFF and Ukemi Comfort Tech', r.every((f) => f.bannerText === `${f.phase === 0 ? 'ON' : 'OFF'} Ukemi Comfort Tech`), r[0].bannerText);
const loco = r.filter((f) => f.loco);
const stuck = loco.filter((f) => f.speed < 0.25).length / Math.max(1, loco.length);
check('avatar walks by itself, rarely blocked', loco.length > r.length * 0.4 && stuck < 0.15,
  `${((100 * loco.length) / r.length).toFixed(0)}% walking, ${(100 * stuck).toFixed(0)}% of it blocked`);

// Switch card: each phase opens on black with the big label, and the
// teleport back to the start happens while the view is black.
{
  const starts = [];
  r.forEach((f, i) => { if (i && f.phase !== r[i - 1].phase) starts.push(i); });
  const cardOk = starts.every((i) => r.slice(i, i + 25).every((f) => f.fade > 0.99 && f.card > 0.99));
  const jumps = r.map((f, i) => (i && Math.hypot(f.body[0] - r[i - 1].body[0], f.body[1] - r[i - 1].body[1]) > 0.3 ? i : -1)).filter((i) => i > 0);
  const hidden = jumps.every((i) => r[i].fade > 0.99);
  const clear = r.filter((f, i) => starts.some((st) => i > st + 60 && i < st + 240)).every((f) => f.fade < 0.01 && f.card < 0.01);
  check('switch card: black + ON/OFF label at each switch, teleport hidden, clear in between', cardOk && hidden && jumps.length >= starts.length && clear,
    `${starts.length} switches, ${jumps.length} teleports`);
}

// Fixed route: every run starts at the spawn and walks the same path.
const runs = [];
r.forEach((f, i) => { if (i === 0 || f.phase !== r[i - 1].phase) runs.push({ phase: f.phase, path: [] }); runs.at(-1).path.push(f.body); });
const full = runs.slice(1, -1);
// Stop-and-go: inside each run the avatar stops (back to idle) and walks on.
{
  let k = 0;
  const stops = [];
  r.forEach((f, i) => {
    if (i && f.phase !== r[i - 1].phase) k++;
    if (k < 1 || k > full.length) return;
    const prev = r[i - 1];
    if (prev.phase === f.phase && prev.loco && !f.loco) stops[k - 1] = (stops[k - 1] || 0) + 1;
  });
  check('walk is stop-and-go (ON stops twice, OFF once)', full.every((run, i) => (stops[i] || 0) >= (run.phase === 0 ? 2 : 1)),
    full.map((run, i) => `${run.phase ? 'OFF' : 'ON'}:${stops[i] || 0}`).join(' '));
}
const startOff = Math.max(...full.map((run) => Math.hypot(run.path[0][0] - spawnXZ[0], run.path[0][1] - spawnXZ[1])));
check('each run teleports back to the start', startOff < 0.15, `max ${startOff.toFixed(2)} m from spawn`);
let dev = 0;
for (const run of full.slice(1)) {
  for (let k = 0; k < Math.min(run.path.length, full[0].path.length); ++k) {
    dev = Math.max(dev, Math.hypot(run.path[k][0] - full[0].path[k][0], run.path[k][1] - full[0].path[k][1]));
  }
}
const len = full[0].path.reduce((a, p, k, arr) => a + (k ? Math.hypot(p[0] - arr[k - 1][0], p[1] - arr[k - 1][1]) : 0), 0);
check('ON and OFF walk the same fixed route', dev < 0.6 && len > 3, `route ${len.toFixed(1)} m, max deviation ${dev.toFixed(2)} m`);

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

// Any key takes over; 10 s without input plays the demo again, from the top.
const idle = await page.evaluate(() => {
  const u = window.ukemi;
  u.pause();
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
  const took = !u.demo.active && u.autoDemo;
  for (let i = 0; i < 60 * 9; ++i) u.step(1 / 60);
  const still = !u.demo.active;
  for (let i = 0; i < 60 * 1.5; ++i) u.step(1 / 60);
  const back = u.demo.active && u.demo.phaseIndex === 0;
  u.resume();
  return { took, still, back };
});
check('any key exits the demo', idle.took);
check('10 s without input plays the demo again from ON', idle.still && idle.back, JSON.stringify(idle));

await page.evaluate(() => window.ukemi.disarmDemo());
const after = await page.evaluate(() => ({ active: window.ukemi.demo.active, banner: document.getElementById('demo-banner').hidden, follow: window.ukemi.cameraRig.followMode }));
check('stopping the demo hides the banner and restores the setting', !after.active && after.banner && after.follow === 'discrete');
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
