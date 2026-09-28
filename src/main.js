// UkemiXR Splat Walk: open a Gaussian splat (.spz / .ply), walk around it
// with the Unity locomotion rig, and step into it with a WebXR headset.
//
//   rendering   three.js + Spark (World Labs' splat renderer, the one Marble
//               uses), which also handles the stereo views in WebXR
//   collision   collision/VoxelWorld.js - voxelised from the splats at load
//   locomotion  locomotion/* - ports of the Unity VRPlayerLocomotion scripts
//   VR          plain WebXR (immersive-vr, local-floor) through three.js,
//               with an in-headset menu (xr/VrMenu.js)
//
// App modes (class on <body>):
//   intro   landing page over the live scene, slow cinematic camera
//   walk    the locomotion rig, first/third person, collision
//   object  fallback for captures with no floor to stand on (a statue, a
//           product scan): orbit around it instead of walking

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { VoxelWorld } from './collision/VoxelWorld.js';
import { PlayerInput } from './locomotion/PlayerInput.js';
import { InputSources } from './locomotion/InputSources.js';
import { CameraRig } from './locomotion/CameraRig.js';
import { PlayerController } from './locomotion/PlayerController.js';
import { Avatar, AVATARS } from './avatar/Avatar.js';
import { XrControllers } from './xr/XrControllers.js';
import { VrMenu } from './xr/VrMenu.js';
import { AutoDemo, PHASE_SECONDS } from './demo/AutoDemo.js';
import { SAMPLES } from './samples.js';
import { loadSettings, saveSettings, FOLLOW_MODES } from './settings.js';
import { SITE } from './site.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const FORMATS = ['spz', 'ply', 'splat', 'ksplat', 'sog'];

// Optional emulated headset (Meta's IWER) for testing the VR path without one.
if (params.has('xremu')) {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  window.__xrDevice = device;
}

// ---------------------------------------------------------------- renderer

const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: params.has('test') });
} catch (err) {
  document.body.innerHTML = '<p class="noscript">This browser does not support WebGL2, so it cannot show 3D scenes. Please use a recent Chrome, Edge or Safari.</p>';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f47, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 5, 3);
scene.add(sun);

// rig = Unity's XR Origin; camera = the HMD.
const rig = new THREE.Group();
rig.name = 'XR Origin';
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.03, 1000);
rig.add(camera);
scene.add(rig);

// Fade shell around the eyes: darkens when the head is inside a wall. Cuts
// (including the jump back into the head) are instant, with no blink.
const fade = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
);
fade.renderOrder = 1e6;
fade.visible = false;
camera.add(fade);
let wallFade = 0;

// ---------------------------------------------------------------- state

const settings = loadSettings();
const avatar = new Avatar(AVATARS[params.get('avatar')] || AVATARS.xbot);
scene.add(avatar.root);
const avatarReady = avatar.load().catch((e) => console.warn('avatar failed to load', e));

const input = new PlayerInput();
const sources = new InputSources(canvas);
let world = null;
let splatMesh = null;
let flipped = false;
let spawn = null;
let spawnYaw = 0;
let current = null; // { id, name, url?, file? }
let userScene = null; // last file the user opened, for the VR menu
let mode = 'intro';
let pendingExplore = false;
let loadToken = 0;
let orbit = null;

const player = new PlayerController({ input, cameraRig: null, world: null, avatar });
const cameraRig = new CameraRig({
  rig,
  camera,
  input,
  avatarHead: (out) => player.avatarHead(out),
  raycast: (o, d, max) => (world ? world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, max) : Infinity),
});
player.cameraRig = cameraRig;

// Auto demo (booth mode: ?demo, the Auto demo buttons, the VR menu). While
// armed it plays whenever nobody is driving: any key or button hands control
// to the visitor, IDLE_RESUME seconds without input plays it again, and a
// headset that is put (back) on starts it over from the top.
const demo = new AutoDemo({
  player,
  cameraRig,
  start: () => (spawn?.ok ? { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawnYaw } : null),
  respawn: () => respawn(),
});
demo.onPhase = () => { applySettings(); updateDemoUi(true); };
const IDLE_RESUME = 10;
let autoDemo = false; // armed
let lastInputAt = 0;

// Desktop look: yaw/pitch of the camera inside the rig. In XR the headset
// owns the camera pose and this is ignored.
const look = { yaw: 0, pitch: -0.05 };
function applyDesktopLook() {
  camera.position.set(0, 0, 0);
  camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
}
applyDesktopLook();

const FOLLOW_LABELS = { discrete: 'Steady cuts', firstPerson: 'First person' };

function applySettings() {
  cameraRig.followMode = demo.active ? demo.follow : settings.follow;
  $('settings').classList.toggle('first-person', settings.follow === 'firstPerson');
  $('s-follow').value = settings.follow;
  guides.right.setRows(rightGuideRows());
  cameraRig.catchUpInterval = settings.catchUp;
  cameraRig.orbitRadius = settings.orbit;
  cameraRig.snapAngleDeg = settings.snap;
  player.moveSpeed = settings.speed;
  if (world) world.setSolidWeight(settings.solid);
  debugDirty = true;
  saveSettings(settings);
}

// ---------------------------------------------------------------- modes

function setMode(next) {
  mode = next;
  document.querySelector('.bar').classList.remove('scrolled');
  document.body.classList.remove('mode-intro', 'mode-walk', 'mode-object');
  document.body.classList.add(`mode-${next}`);
  if (next !== 'walk') $('settings').hidden = true;
  if (next === 'object') setupOrbit();
  else disposeOrbit();
  if (next === 'walk' && world) {
    if (demo.active) demo.restart();
    else respawn();
    canvas.focus({ preventScroll: true });
  }
  updateHud();
  updateDemoUi(true);
}

function explore() {
  if (!world) {
    pendingExplore = true;
    return;
  }
  setMode(world.walkable ? 'walk' : 'object');
}

function goHome() {
  if (renderer.xr.isPresenting) return;
  setMode('intro');
  $('intro').scrollTo({ top: 0 });
  attractT0 = time;
}

// ---------------------------------------------------------------- loading

async function loadSplat(entry) {
  const { url, file } = entry;
  const title = entry.name || file?.name || url.split('/').pop();
  const token = ++loadToken;
  showProgress(title, 'Downloading…', 0);
  let mesh = null;
  try {
    if (file && isLikelyMobile() && file.size > 350 * 1048576) {
      toast(`Large file (${mb(file.size)}) — a phone may run out of memory`, true);
    }
    const options = {
      onProgress: (e) => {
        if (token === loadToken && e.lengthComputable && e.total) {
          setProgress(e.loaded / e.total, `Downloading… ${mb(e.loaded)} / ${mb(e.total)}`);
        }
      },
    };
    if (file) {
      setProgress(null, 'Reading file…');
      options.fileBytes = new Uint8Array(await file.arrayBuffer());
      options.fileName = file.name;
    } else {
      options.url = url;
    }
    // A streamed scene (.rad) only fetches the coarse levels up front and
    // pages in detail around the viewer, so the splats are not all in memory
    // and its collision comes prebaked instead.
    if (entry.paged) options.paged = true;
    const prebaked = entry.collision ? fetchWalkGrid(entry.collision, token) : null;
    prebaked?.catch(() => {}); // awaited below; do not report it twice if the splats fail first
    mesh = new SplatMesh(options);
    mesh.userData.frame = entry.frame;
    await mesh.initialized;
    if (token !== loadToken) { mesh.dispose?.(); return; }
    if (!entry.paged && countSplats(mesh) === 0) throw new Error('The file contains no splats');

    let built, t0;
    if (prebaked) {
      const grid = await prebaked;
      if (token !== loadToken) { mesh.dispose?.(); return; }
      t0 = performance.now();
      built = prebakedWorldFor(mesh, entry, grid);
    } else {
      setProgress(null, 'Building collision…');
      await nextFrame();
      t0 = performance.now();
      built = buildWorldFor(mesh, entry);
    }
    if (token !== loadToken) { mesh.dispose?.(); return; }

    // Swap only once the new scene is fully ready: a bad file never leaves
    // you with an empty screen.
    if (splatMesh) {
      scene.remove(splatMesh);
      splatMesh.dispose?.();
    }
    splatMesh = mesh;
    scene.add(mesh);
    world = built.world;
    flipped = built.flipped;
    player.world = world;
    current = { ...entry, name: title };
    if (file) userScene = { id: 'user', name: title, file };
    spawn = built.spawn;
    spawnYaw = spawn.ok ? world.openYaw(spawn.x, spawn.y, spawn.z, entry.spawn?.yaw ?? 0) : 0;
    world.walkable = built.walkable;
    updateSceneInfo(Math.round(performance.now() - t0));
    hideProgress();
    refreshSceneLists();
    menu.redraw();
    debugDirty = true;

    if (renderer.xr.isPresenting) {
      setMode(world.walkable ? 'walk' : 'object');
      placeXrForMode();
    } else if (mode === 'intro' && !pendingExplore) {
      attractT0 = time;
    } else {
      pendingExplore = false;
      setMode(world.walkable ? 'walk' : 'object');
    }
    if (!world.walkable) toast('This capture has no floor to walk on, so it opens as a 3D view — drag to look around, scroll to zoom');
    else if (mode !== 'intro' && !demo.active) toast(`Now walking: ${title}`);
  } catch (err) {
    console.error(err);
    mesh?.dispose?.();
    if (token === loadToken) {
      hideProgress();
      pendingExplore = false;
      toast(`Couldn’t open this file: ${friendlyError(err)}${splatMesh ? '. The current scene is still loaded.' : ''}`, true);
    }
  }
}

function countSplats(mesh) {
  let n = 0;
  mesh.forEachSplat(() => { ++n; });
  return n;
}

// Collision for a freshly loaded mesh, and which way up it goes.
//
// Our samples (Marble / World Labs exports) are +Y up with the floor at y≈0,
// so they are trusted as is. A user's file could be either: captures straight
// out of the original 3DGS trainer are usually upside down, and an indoor
// scene upside down is still "walkable" - on its ceiling. So both ways up are
// built and the one with more stuff standing on its floor wins. A scene with
// less than MIN_WALK_AREA to walk on (a statue, one sofa) opens in object
// mode instead.
// A real room gives well over 10 m²; one sofa on its own gives ~3.
const MIN_WALK_AREA = 6;

function buildWorldFor(mesh, entry) {
  const attempt = (flip) => {
    orient(mesh, flip);
    const world = buildWorld(mesh);
    const spawn = world.findSpawnAnywhere();
    const area = spawn.ok ? world.reachableArea(spawn) : 0;
    const score = spawn.ok ? world.uprightScore(spawn) : -1;
    return { world, spawn, flipped: flip, area, score, walkable: spawn.ok && area >= MIN_WALK_AREA };
  };
  const forced = params.get('flip');
  const first = attempt(forced ? forced === '1' : false);
  if (forced || entry.upright) return first;
  const second = attempt(!first.flipped);
  const pick = (a, b) => {
    if (a.walkable !== b.walkable) return a.walkable ? a : b;
    return a.score >= b.score ? a : b;
  };
  const r = pick(first, second);
  orient(mesh, r.flipped);
  return r;
}

// Prebaked collision for a scene taken from superspl.at is in PlayCanvas's
// frame, which is the PLY turned 180° about Z; the splats are shown in it too.
const FRAMES = { playcanvas: new THREE.Quaternion(0, 0, 1, 0) };

// Collision that ships with the scene (see collision/walkGrid.js). The grid
// is stored gzipped; a server may or may not have undone that already.
async function fetchWalkGrid(url, token) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load collision (${res.status})`);
  const total = +res.headers.get('Content-Length') || 0;
  const parts = [];
  let loaded = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (token === loadToken) setProgress(total ? loaded / total : null, `Downloading… ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}`);
  }
  let bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return bytes.buffer;
}

function prebakedWorldFor(mesh, entry, grid) {
  orient(mesh, false);
  const world = VoxelWorld.fromWalkGrid(grid, { solidWeight: settings.solid });
  const at = entry.spawn || { x: 0, z: 0 };
  const spawn = world.findSpawn(at.x, at.z, 3);
  const walkable = spawn.ok && world.reachableArea(spawn) >= MIN_WALK_AREA;
  return { world, spawn, flipped: false, walkable };
}

function orient(mesh, flip) {
  const frame = FRAMES[mesh.userData.frame];
  if (frame) mesh.quaternion.copy(frame);
  else if (flip) mesh.quaternion.set(1, 0, 0, 0);
  else mesh.quaternion.identity();
  mesh.updateMatrixWorld(true);
}

function buildWorld(mesh) {
  const m = mesh.matrixWorld.clone();
  const mq = new THREE.Quaternion();
  const ms = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), mq, ms);
  const sc = ms.x;
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const count = countSplats(mesh);
  return VoxelWorld.build({
    count,
    forEach(cb) {
      mesh.forEachSplat((i, c, s, quat, opacity) => {
        v.copy(c).applyMatrix4(m);
        q.copy(quat).premultiply(mq);
        cb(v.x, v.y, v.z, s.x * sc, s.y * sc, s.z * sc, q.x, q.y, q.z, q.w, opacity);
      });
    },
  }, { solidWeight: settings.solid });
}

async function reflip() {
  if (!splatMesh) return;
  if (world?.stats.prebaked) {
    toast('This scene ships with its own collision, so its orientation is fixed');
    return;
  }
  showProgress(current?.name || '', 'Rebuilding collision…', null);
  await nextFrame();
  flipped = !flipped;
  orient(splatMesh, flipped);
  world = buildWorld(splatMesh);
  player.world = world;
  spawn = world.findSpawnAnywhere();
  world.walkable = spawn.ok && world.reachableArea(spawn) >= MIN_WALK_AREA;
  spawnYaw = spawn.ok ? world.openYaw(spawn.x, spawn.y, spawn.z, 0) : 0;
  updateSceneInfo(world.stats.buildMs);
  hideProgress();
  setMode(world.walkable ? 'walk' : 'object');
}

function respawn() {
  if (!world || !spawn?.ok) return;
  look.yaw = 0;
  look.pitch = -0.05;
  rig.position.set(0, 0, 0);
  rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawnYaw);
  if (!renderer.xr.isPresenting) applyDesktopLook();
  rig.updateMatrixWorld(true);
  player.placeAt(spawn.x, spawn.y, spawn.z, spawnYaw + Math.PI);
}

function updateSceneInfo(buildMs) {
  const st = world.stats;
  const splats = st.prebaked ? 'streamed' : `${st.splats.toLocaleString()} splats`;
  const credit = current?.credit ? ` · ${current.credit}` : '';
  $('scene-info').textContent =
    `${current?.name}: ${splats} · ${st.voxel.toFixed(2)} m voxels · ${st.dims.join('×')} grid · ${buildMs} ms${credit}`;
}

// ---------------------------------------------------------------- object mode

function sceneBounds() {
  const b = world.stats.bounds;
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const r = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) - 0.75;
  return { c, r: Math.max(0.3, r) };
}

function setupOrbit() {
  disposeOrbit();
  if (!world || renderer.xr.isPresenting) return;
  avatar.setFirstPerson(true);
  const { c, r } = sceneBounds();
  rig.position.set(0, 0, 0);
  rig.quaternion.identity();
  rig.updateMatrixWorld(true);
  camera.position.set(c.x + r * 1.2, c.y + r * 0.5, c.z + r * 1.4);
  orbit = new OrbitControls(camera, canvas);
  orbit.target.copy(c);
  orbit.enableDamping = true;
  orbit.minDistance = r * 0.2;
  orbit.maxDistance = r * 6;
  orbit.update();
}

function disposeOrbit() {
  if (!orbit) return;
  orbit.dispose();
  orbit = null;
  applyDesktopLook();
}

// ---------------------------------------------------------------- XR

let xrSession = null;
let xrFrames = 0;
let xrSupported = false;
const xr = new XrControllers(renderer, rig);
const raycaster = new THREE.Raycaster();

const menu = new VrMenu({
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
  items: () => {
    const scenes = SAMPLES.filter((s) => !s.dev).map((s) => ({
      id: s.id, kind: 'scene', label: s.name, sub: s.kind, thumb: s.thumb, active: current?.id === s.id,
    }));
    if (userScene) scenes.push({ id: 'user', kind: 'scene', label: userScene.name, sub: 'Your model', thumb: null, active: current?.id === 'user' });
    return [
      ...scenes,
      { id: 'close', kind: 'action', label: 'Continue', sub: 'Close menu', primary: true },
      { id: 'respawn', kind: 'action', label: 'Respawn', sub: 'Back to start' },
      { id: 'demo', kind: 'action', label: autoDemo ? 'Stop auto demo' : 'Auto demo', sub: autoDemo ? 'Turn booth mode off' : 'ON vs OFF, hands-free' },
      { id: 'exit', kind: 'action', label: 'Exit VR', sub: 'Back to browser' },
    ];
  },
  onPick: (id) => {
    if (id === 'close') closeMenu();
    else if (id === 'respawn') { closeMenu(); respawn(); }
    else if (id === 'demo') { closeMenu(); autoDemo ? disarmDemo() : armDemo(); }
    else if (id === 'exit') { closeMenu(); xrSession?.end(); }
    else if (id === 'user' && userScene) { closeMenu(); if (current?.id !== 'user') loadSplat(userScene); }
    else {
      const s = SAMPLES.find((x) => x.id === id);
      closeMenu();
      if (s && current?.id !== s.id) loadSplat(s);
    }
  },
});
scene.add(menu.mesh);
xr.onSelect = (hand) => menu.select(hand);

function openMenu() {
  const head = cameraRig.hmdPosition(new THREE.Vector3());
  menu.show(head, cameraRig.hmdYaw());
  xr.setRaysVisible(true);
}
function closeMenu() {
  menu.hide();
  xr.setRaysVisible(false);
}

// Controls cheat sheet on each controller while in VR.
function rightGuideRows() {
  return [['A', `Camera: ${FOLLOW_LABELS[settings.follow]}`, true], ['Stick', 'Turn'], ['Trigger', 'Select']];
}
const guides = {
  left: makeGuideLabel([['Stick', 'Walk'], ['X / Y', 'Menu']]),
  right: makeGuideLabel(rightGuideRows()),
};

function toggleFollow() {
  const i = FOLLOW_MODES.indexOf(settings.follow);
  settings.follow = FOLLOW_MODES[(i + 1) % FOLLOW_MODES.length];
  applySettings();
  try { xr.hands.right?.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40); } catch { /* optional */ }
}

async function initXr() {
  const label = $('vr-label');
  const button = $('vr');
  try {
    xrSupported = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
  } catch { /* not supported */ }
  if (!xrSupported) {
    document.body.classList.add('xr-unsupported');
    label.textContent = window.isSecureContext ? 'Enter VR' : 'VR needs HTTPS';
    button.title = 'No VR headset found. Open this page in the Quest, Pico or Vision Pro browser to enter VR.';
    return;
  }
  label.textContent = 'Enter VR';
  button.disabled = false;
  button.addEventListener('click', toggleXr);
}

function vrHeroClicked() {
  if (xrSupported) {
    toggleXr();
    return;
  }
  const link = location.origin + location.pathname;
  navigator.clipboard?.writeText(link).catch(() => {});
  toast(`Open ${link} in your Quest, Pico or Vision Pro browser and tap “Enter VR” (link copied)`);
}

async function toggleXr() {
  if (xrSession) {
    await xrSession.end();
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    xrSession = session;
    renderer.xr.setFramebufferScaleFactor(settings.xrScale);
    await renderer.xr.setSession(session);
    xrFrames = 0;
    $('vr-label').textContent = 'Exit VR';
    if (world) setMode(world.walkable ? 'walk' : 'object');
    else pendingExplore = true;
    applySettings();
    // WebXR cannot read the proximity sensor. What a page does see is its
    // effect: nobody in the headset -> the display goes off and the session
    // turns hidden (and stops producing frames); someone looks in -> visible
    // again. Either of those restarts the demo (see also frame()).
    session.addEventListener('visibilitychange', () => {
      wearState = session.visibilityState;
      updateDemoUi(true);
      if (session.visibilityState === 'visible') headsetPutOn('session visible');
    });
    session.addEventListener('end', () => {
      xrSession = null;
      closeMenu();
      $('vr-label').textContent = 'Enter VR';
      look.yaw = cameraRig.hmdYaw() - rigYaw();
      look.pitch = 0;
      applyDesktopLook();
      applySettings();
      if (world && mode === 'walk') player.enterIdle();
      if (mode === 'object') setupOrbit();
      updateDemoUi(true);
    });
  } catch (err) {
    console.error(err);
    toast(`Couldn’t enter VR: ${err?.message || err}`, true);
  }
}

// Once the headset reports a pose, put it where the mode wants it.
function placeXrForMode() {
  if (!world) return;
  if (mode === 'walk') {
    if (autoDemo) playDemo();
    else if (player.state === 'idle') player.enterIdle();
    else respawn();
  } else if (mode === 'object') {
    const { c, r } = sceneBounds();
    const d = Math.max(1.5, r * 1.6);
    rig.quaternion.identity();
    rig.position.set(c.x, c.y - 1.1, c.z + d);
    rig.updateMatrixWorld(true);
  }
}

function rigYaw() {
  return new THREE.Euler().setFromQuaternion(rig.quaternion, 'YXZ').y;
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let time = 0;
let attractT0 = 0;
let paused = false;
let renderEnabled = !params.has('norender');
let fpsFrames = 0, fpsTime = 0, fps = 0;
const NO_INPUT = { move: { x: 0, y: 0 }, right: { x: 0, y: 0 }, a: false, b: false };

function step(dt) {
  time += dt;
  const presenting = renderer.xr.isPresenting;
  let raw = sources.read(presenting ? renderer.xr.getSession() : null);

  if (presenting) {
    sources.consumeLook();
    if (++xrFrames === 3) placeXrForMode();
    const menuButton = xr.pressed('left', 4) || xr.pressed('left', 5);
    const aButton = xr.pressed('right', 4);
    // The press that takes over from the demo does nothing else.
    if (!(xrInputSeen() && noteUserInput())) {
      if (menuButton) (menu.open ? closeMenu() : openMenu());
      if (aButton && !menu.open && mode === 'walk') toggleFollow();
    }
    if (menu.open) {
      raw = NO_INPUT;
      for (const hand of ['right', 'left']) {
        const rc = xr.worldRay(hand, raycaster);
        if (rc) xr.showHit(hand, menu.pointer(hand, rc));
      }
    }
  } else if (mode === 'walk') {
    const d = sources.consumeLook();
    look.yaw -= d.x * 0.0035;
    look.pitch = THREE.MathUtils.clamp(look.pitch - d.y * 0.0035, -1.35, 1.35);
    applyDesktopLook();
  } else {
    sources.consumeLook();
  }

  if (mode === 'intro' && !presenting) {
    attract(time - attractT0);
    raw = NO_INPUT;
  }
  if (autoDemo && !demo.active && world && mode === 'walk' && !menu.open && time - lastInputAt > IDLE_RESUME) playDemo();
  if (demo.active && world && mode === 'walk' && !menu.open) {
    raw = demo.update(dt);
    updateDemoUi();
  }

  input.update(time, raw);
  if (world && mode === 'walk') {
    player.update(dt);
    cameraRig.lateUpdate(dt);
  } else if (mode === 'object') {
    orbit?.update();
  }

  // Room-scale: the body stops at walls but a real head does not. Fade out
  // while the headset is inside geometry or on the far side of it from where
  // the body stands (first person only - in third person the camera is
  // clipped against walls by the rig itself).
  let wallTarget = 0;
  if (presenting && world && mode === 'walk' && !cameraRig.thirdPerson) {
    const h = cameraRig.hmdPosition(new THREE.Vector3());
    const a = player.avatarHead(new THREE.Vector3());
    const d = h.clone().sub(a);
    const len = d.length();
    if (world.headInside(h.x, h.y, h.z) ||
        (len > 0.05 && world.raycast(a.x, a.y, a.z, d.x, d.y, d.z, len) < len)) wallTarget = 0.92;
  }
  wallFade += (wallTarget - wallFade) * Math.min(1, dt * 10);
  fade.visible = wallFade > 0.01;
  fade.material.opacity = wallFade;

  for (const hand of ['left', 'right']) {
    const g = guides[hand], e = xr.hands[hand];
    g.visible = presenting && !!e && e.model.visible && mode === 'walk' && !demo.active;
    if (g.visible && g.parent !== e.grip) e.grip.add(g);
  }
  updateDebug();
  updateHelpCard(dt);
}

// Intro: a slow drift and look-around from the spawn, eye height.
function attract(t) {
  if (!world || !spawn?.ok) return;
  const base = new THREE.Vector3(spawn.x, spawn.y + player.eyeHeight, spawn.z);
  const fwd = new THREE.Vector3(-Math.sin(spawnYaw), 0, -Math.cos(spawnYaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const ease = Math.min(1, t / 3);
  base.addScaledVector(right, 0.35 * Math.sin((t * Math.PI * 2) / 46) * ease);
  base.addScaledVector(fwd, 0.25 * Math.sin((t * Math.PI * 2) / 61) * ease);
  rig.position.copy(base);
  rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawnYaw + 0.3 * Math.sin((t * Math.PI * 2) / 38) * ease);
  camera.position.set(0, 0, 0);
  camera.rotation.set(-0.06, 0, 0, 'YXZ');
  avatar.setFirstPerson(true);
}

function frame() {
  const gap = clock.getDelta();
  const dt = Math.min(gap, 0.1);
  // No frames for a while in the headset: it was taken off (the browser
  // stops rendering). Whoever puts it on next sees the demo from the start.
  if (gap > 1.5 && renderer.xr.isPresenting) headsetPutOn(`frame gap ${gap.toFixed(1)} s`);
  if (!paused) step(dt);
  window.ukemi?.afterFrame?.(dt);
  if (renderEnabled || renderer.xr.isPresenting) renderer.render(scene, camera);
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime > 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    updateHud();
  }
}
renderer.setAnimationLoop(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

// ---------------------------------------------------------------- debug view

let debugPoints = null;
let debugDirty = true;
const debugCenter = new THREE.Vector3(1e9, 0, 0);

function clearDebug() {
  if (debugPoints) {
    scene.remove(debugPoints);
    debugPoints.geometry.dispose();
    debugPoints = null;
  }
}

function updateDebug() {
  if (!settings.debug || !world || mode !== 'walk') {
    clearDebug();
    return;
  }
  const p = player.body;
  const moved = Math.hypot(p.x - debugCenter.x, p.z - debugCenter.z) > 2.5 || Math.abs(p.y - debugCenter.y) > 0.3;
  if (!debugDirty && !moved && debugPoints) return;
  debugDirty = false;
  debugCenter.set(p.x, p.y, p.z);
  clearDebug();
  const vox = world.debugVoxels(p.x, p.y, p.z, 7);
  const n = vox.length / 4;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const walk = new THREE.Color(0x3ddc97), block = new THREE.Color(0xff7a45);
  for (let i = 0; i < n; ++i) {
    pos[i * 3] = vox[i * 4]; pos[i * 3 + 1] = vox[i * 4 + 1]; pos[i * 3 + 2] = vox[i * 4 + 2];
    (vox[i * 4 + 3] ? block : walk).toArray(col, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  debugPoints = new THREE.Points(g, new THREE.PointsMaterial({
    size: world.voxel * 0.55, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  debugPoints.renderOrder = 10;
  scene.add(debugPoints);
}

// ---------------------------------------------------------------- UI

// The controls card has done its job once someone has walked a few metres.
let walkedForHelp = 0;
function updateHelpCard(dt) {
  if (walkedForHelp < 0 || mode !== 'walk') return;
  walkedForHelp += player.speed * dt;
  if (walkedForHelp > 4) {
    walkedForHelp = -1;
    $('help').classList.add('collapsed');
    $('help-toggle').setAttribute('aria-expanded', 'false');
  }
}

function updateHud() {
  const s = $('hud-state');
  s.classList.toggle('third', mode === 'walk' && cameraRig.thirdPerson);
  s.classList.toggle('object', mode === 'object');
  s.textContent = mode === 'object' ? '3D view' : player.isLocomoting ? 'Walking' : 'Looking around';
  const b = player.body;
  const debugInfo = params.has('debug') ? ` · ${fps.toFixed(0)} fps · (${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)})` : '';
  $('hud-info').textContent = !world ? '' : mode === 'object'
    ? `Drag to look around · scroll to zoom${debugInfo}`
    : `${current?.name ?? ''} · WASD to walk · drag to look${debugInfo}`;
}

// One progress UI for both modes: inline under the hero, a card otherwise.
let progressTitle = '';
function showProgress(title, stage, p) {
  progressTitle = title;
  const inline = mode === 'intro';
  $('intro-progress').hidden = !inline;
  $('loading').hidden = inline;
  $('loading-title').textContent = title;
  setProgress(p, stage);
}
function setProgress(p, stage) {
  for (const id of ['loading-bar', 'intro-progress-bar']) {
    const bar = $(id);
    bar.parentElement.classList.toggle('indeterminate', p === null);
    if (p !== null) bar.style.width = `${Math.round(p * 100)}%`;
  }
  if (stage) {
    $('loading-stage').textContent = stage;
    $('intro-progress-label').textContent = `${progressTitle} · ${stage}`;
  }
}
function hideProgress() {
  $('loading').hidden = true;
  $('intro-progress').hidden = true;
}

let toastTimer = 0;
function toast(msg, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 4000);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const isLikelyMobile = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;

function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (/fetch|network|Failed to load|404/i.test(m)) return 'it could not be downloaded (check the link or its CORS settings)';
  if (/memory|allocation/i.test(m)) return 'not enough memory for a file this large';
  if (/unknown|unsupported|format|header|magic|parse|invalid|missing|property|offset|bounds/i.test(m)) return 'it is incomplete or not a Gaussian splat file';
  return m || 'unknown error';
}

const ICON_ARROW = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10M11 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_UPLOAD = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3.5M6.2 7.2 10 3.5l3.8 3.7M3.5 12.5v2A2 2 0 0 0 5.5 16.5h9a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function refreshSceneLists() {
  const sel = $('sample');
  const opts = SAMPLES.map((s) => `<option value="${s.id}">${s.name}</option>`);
  if (userScene) opts.push(`<option value="user">${escapeHtml(userScene.name)} (imported)</option>`);
  if (current && !['user', ...SAMPLES.map((s) => s.id)].includes(current.id)) {
    opts.push(`<option value="${escapeHtml(current.id)}">${escapeHtml(current.name)}</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = current?.id ?? '';

  $('cards').innerHTML = SAMPLES.filter((s) => !s.dev).map((s) => `
    <button class="card" type="button" data-id="${s.id}">
      <img class="thumb" src="${s.thumb}" alt="${s.name}" loading="lazy" />
      ${current?.id === s.id ? '<span class="badge">Now showing</span>' : ''}
      <span class="go">${ICON_ARROW}</span>
      <span class="meta">
        <span class="title">${s.name}</span>
        <span class="kind">${s.kind}</span>
        <span class="sub">${s.sub}</span>
        <span class="tags">${s.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</span>
        ${s.credit ? `<span class="credit">${s.credit}</span>` : ''}
      </span>
    </button>`).join('') + `
    <button class="card import" type="button" data-id="import">
      <span class="thumb">${ICON_UPLOAD}</span>
      <span class="meta">
        <span class="title">Walk your own capture</span>
        <span class="sub">Have a scan already? Open a .spz or .ply file, or drop it anywhere on this page.</span>
        <span class="tags"><span class="tag">Stays on your computer — never uploaded</span></span>
      </span>
    </button>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pickScene(id) {
  if (id === 'import') { $('file').click(); return; }
  if (id === 'user' && userScene) {
    if (current?.id === 'user') explore();
    else { pendingExplore = true; loadSplat(userScene); }
    return;
  }
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  history.replaceState(null, '', `?scene=${s.id}`);
  if (current?.id === s.id && world) { explore(); return; }
  pendingExplore = true;
  loadSplat(s);
}

function setupUi() {
  refreshSceneLists();
  $('cards').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) pickScene(card.dataset.id);
  });
  $('sample').addEventListener('change', (e) => pickScene(e.target.value));
  $('explore').addEventListener('click', explore);
  $('vr-hero').addEventListener('click', vrHeroClicked);
  $('demo-hero').addEventListener('click', () => { armDemo(); if (xrSupported && !xrSession) toggleXr(); });
  $('demo').addEventListener('click', () => (autoDemo ? disarmDemo() : armDemo()));
  $('import-hero').addEventListener('click', () => $('file').click());
  $('explore-2').addEventListener('click', explore);
  // Contact buttons appear once src/site.js has somewhere to send people.
  const contact = SITE.contactUrl || (SITE.contactEmail && `mailto:${SITE.contactEmail}?subject=${encodeURIComponent('UkemiXR capture')}`);
  if (contact) $('closing-text').textContent = 'Walk the demo now, or tell us about the place you want people to visit.';
  for (const el of document.querySelectorAll('.contact-link')) {
    if (!contact) continue;
    el.href = el.id === 'contact-hero' ? '#contact' : contact;
    el.hidden = false;
  }
  const bar = document.querySelector('.bar');
  $('intro').addEventListener('scroll', () => bar.classList.toggle('scrolled', mode === 'intro' && $('intro').scrollTop > 40), { passive: true });
  $('home').addEventListener('click', (e) => { e.preventDefault(); goHome(); });

  // Open file / drag and drop.
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';
  });
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (++dragDepth === 1) $('drop').hidden = false; });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  // WASD on the landing page starts walking.
  addEventListener('keydown', (e) => {
    if (mode === 'intro' && world && /^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code) &&
        !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) explore();
  });

  // Settings.
  const toggle = $('settings-toggle');
  toggle.addEventListener('click', () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  const bindRange = (id, key, fmt) => {
    const el = $(`s-${id}`), out = $(`o-${id}`);
    el.value = settings[key];
    out.textContent = fmt(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = +el.value;
      out.textContent = fmt(settings[key]);
      applySettings();
    });
  };
  bindRange('catchup', 'catchUp', (v) => `${v.toFixed(2)} s`);
  bindRange('orbit', 'orbit', (v) => `${v.toFixed(1)} m`);
  bindRange('snap', 'snap', (v) => `${v}°`);
  bindRange('speed', 'speed', (v) => `${v.toFixed(1)} m/s`);
  bindRange('solid', 'solid', (v) => v.toFixed(1));
  const follow = $('s-follow');
  follow.addEventListener('change', () => { settings.follow = follow.value; applySettings(); });
  for (const key of ['debug']) {
    const el = $(`s-${key}`);
    el.checked = settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; applySettings(); });
  }
  $('s-flip').addEventListener('click', reflip);
  $('s-respawn').addEventListener('click', () => (mode === 'walk' ? respawn() : setupOrbit()));

  const help = $('help');
  $('help-toggle').addEventListener('click', () => {
    help.classList.toggle('collapsed');
    $('help-toggle').setAttribute('aria-expanded', String(!help.classList.contains('collapsed')));
  });
}

function openFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  if (!FORMATS.includes(ext)) {
    toast(`.${ext} is not supported — use .spz, .ply, .splat, .ksplat or .sog`, true);
    return;
  }
  history.replaceState(null, '', location.pathname);
  pendingExplore = true;
  loadSplat({ id: 'user', name: f.name, file: f });
}

// A small panel above a controller: one row per control, key pill + action.
// rows: [key, action, highlight?]
function makeGuideLabel(rows) {
  const W = 640, ROW = 96, PAD = 24;
  const c = document.createElement('canvas');
  c.width = W;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  const width = 0.12;
  m.setRows = (list) => {
    c.height = PAD * 2 + ROW * list.length;
    g.clearRect(0, 0, W, c.height);
    g.fillStyle = 'rgba(13,17,23,0.9)';
    g.beginPath();
    g.roundRect(0, 0, W, c.height, 36);
    g.fill();
    g.textBaseline = 'middle';
    list.forEach(([key, action, hi], i) => {
      const y = PAD + ROW * i + ROW / 2;
      g.font = '700 40px system-ui, sans-serif';
      const kw = Math.max(76, g.measureText(key).width + 36);
      g.fillStyle = '#4fd1c5';
      g.beginPath();
      g.roundRect(PAD, y - 30, kw, 60, 30);
      g.fill();
      g.fillStyle = '#0d1117';
      g.textAlign = 'center';
      g.fillText(key, PAD + kw / 2, y + 2);
      g.font = `${hi ? 700 : 500} 42px system-ui, sans-serif`;
      g.fillStyle = hi ? '#ffffff' : 'rgba(255,255,255,0.78)';
      g.textAlign = 'left';
      g.fillText(action, PAD + kw + 22, y + 2, W - PAD * 2 - kw - 22);
    });
    tex.needsUpdate = true;
    m.scale.set(width, (width * c.height) / W, 1);
  };
  m.setRows(rows);
  m.position.set(0, 0.07, -0.01);
  m.rotation.x = -0.6;
  m.renderOrder = 1e5;
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------- auto demo

function armDemo() {
  autoDemo = true;
  closeMenu();
  if (world && mode === 'walk') playDemo();
  else { demo.active = true; explore(); } // setMode('walk') restarts it
  applySettings();
  updateDemoUi(true);
}

function disarmDemo() {
  autoDemo = false;
  pauseDemo();
}

function playDemo() {
  if (!world || mode !== 'walk') return;
  closeMenu();
  demo.play();
  applySettings();
  updateDemoUi(true);
}

// The visitor takes over: they walk on from wherever the demo left them.
function pauseDemo() {
  const was = demo.active;
  demo.stop();
  applySettings();
  if (was && world && mode === 'walk') player.enterIdle();
  updateDemoUi(true);
}

// Any key / click / touch / controller button. Returns true when it took
// over from a running demo.
function noteUserInput() {
  lastInputAt = time;
  if (!demo.active) return false;
  pauseDemo();
  return true;
}
for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
  addEventListener(type, () => noteUserInput(), { capture: true, passive: true });
}

function xrInputSeen() {
  const session = renderer.xr.getSession();
  if (!session) return false;
  for (const source of session.inputSources) {
    const gp = source.gamepad;
    if (!gp) continue;
    if (gp.buttons.some((b) => b.pressed) || gp.axes.some((v) => Math.abs(v) > 0.5)) return true;
  }
  return false;
}

// A new visitor put the headset on: play the demo from the top.
// ?weardebug shows on the in-headset badge which signal fired last, to check
// on site that the headset's proximity sensor really gets through.
const wearDebug = params.has('weardebug');
let wearState = 'visible';
let lastRestart = null; // { reason, at }
function headsetPutOn(reason) {
  lastRestart = { reason, at: time };
  if (autoDemo) playDemo();
  else updateDemoUi(true);
}
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') headsetPutOn('page visible');
});

// In the headset: a head-locked badge above the centre of view. On screen:
// the #demo-banner. Both say whether UkemiXR's camera is on right now.
const demoBadge = makeDemoBadge();
camera.add(demoBadge);
let demoUiKey = '';
let demoWasActive = false;

function updateDemoUi(force = false) {
  const on = demo.active && mode === 'walk';
  const ph = demo.phase;
  const secs = Math.ceil(demo.remaining);
  const presenting = renderer.xr.isPresenting;
  const key = `${on}|${presenting}|${demo.phaseIndex}|${secs}${wearDebug ? debugLine() : ''}`;
  const banner = $('demo-banner');
  if (on) $('demo-bar').style.width = `${(100 * demo.remaining) / PHASE_SECONDS}%`;
  if (!force && key === demoUiKey) return;
  demoUiKey = key;
  if (demoWasActive !== autoDemo) {
    demoWasActive = autoDemo;
    $('demo').setAttribute('aria-pressed', String(autoDemo));
    $('demo-label').textContent = autoDemo ? 'Stop auto demo' : 'Auto demo';
    menu.redraw();
  }
  banner.hidden = !on;
  demoBadge.visible = on && presenting;
  if (!on) return;
  const sub = ph.tech ? 'Steady cuts · no motion sickness' : 'Ordinary first-person camera · the usual VR sickness';
  const next = `${ph.tech ? 'OFF' : 'ON'} in ${secs} s`;
  banner.classList.toggle('on', ph.tech);
  banner.classList.toggle('off', !ph.tech);
  $('demo-state').textContent = ph.tech ? 'ON' : 'OFF';
  $('demo-sub').textContent = sub;
  $('demo-count').textContent = next;
  demoBadge.draw(ph.tech, sub, next, demo.remaining / PHASE_SECONDS);
}

function debugLine() {
  const r = lastRestart ? `${lastRestart.reason}, ${Math.round(time - lastRestart.at)} s ago` : 'none yet';
  return `session ${wearState} · last restart: ${r}`;
}

function makeDemoBadge() {
  const W = 1024, H = 290;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const width = 0.5;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(width, (width * H) / W),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  m.draw = (on, sub, next, left) => {
    const col = on ? '#34d399' : '#f87171';
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(12,15,21,0.9)';
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, 40);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = col;
    g.stroke();
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(36, 40, 230, 130, 28);
    g.fill();
    g.fillStyle = '#0b0e13';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 84px system-ui, sans-serif';
    g.fillText(on ? 'ON' : 'OFF', 151, 108);
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = '700 54px system-ui, sans-serif';
    g.fillText('UkemiXR comfort tech', 300, 78, W - 340);
    g.fillStyle = col;
    g.font = '600 38px system-ui, sans-serif';
    g.fillText(sub, 300, 138, W - 340);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(36, 196, W - 72, 12);
    g.fillStyle = col;
    g.fillRect(36, 196, (W - 72) * left, 12);
    g.fillStyle = '#c6cfdb';
    g.font = '500 28px system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(next, W - 40, 176);
    g.textAlign = 'left';
    g.fillStyle = '#8b95a3';
    g.fillText(wearDebug ? debugLine() : 'Auto demo · press any button to take over', 36, 250, W - 72);
    tex.needsUpdate = true;
  };
  m.position.set(0, 0.2, -1);
  m.rotation.x = 0.2;
  m.renderOrder = 1e5;
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------- test hooks

window.ukemi = {
  THREE, scene, camera, rig, renderer, input, sources, player, cameraRig, avatar, settings, menu, xr, demo,
  armDemo,
  disarmDemo,
  noteUserInput,
  get autoDemo() { return autoDemo; },
  get lastRestart() { return lastRestart; },
  get world() { return world; },
  get spawn() { return spawn; },
  get splatMesh() { return splatMesh; },
  get mode() { return mode; },
  get current() { return current; },
  get fade() { return fade.material.opacity; },
  loadSplat,
  applySettings,
  respawn,
  explore,
  goHome,
  toggleXr,
  openMenu,
  closeMenu,
  pause() { paused = true; },
  resume() { paused = false; clock.getDelta(); },
  step,
  setRender(v) { renderEnabled = v; },
  renderOnce() { renderer.render(scene, camera); },
};

// ---------------------------------------------------------------- boot

setupUi();
applySettings();
initXr();
setMode('intro');
requestAnimationFrame(() => $('boot').classList.add('gone'));
await avatarReady;
{
  const id = params.get('scene');
  const url = params.get('url');
  const sample = SAMPLES.find((s) => s.id === id) || (!url && id !== 'none' && SAMPLES[0]);
  if (params.has('walk')) pendingExplore = true;
  if (params.has('demo')) { autoDemo = true; demo.active = true; pendingExplore = true; applySettings(); }
  if (url) { pendingExplore = true; loadSplat({ id: 'url', url }); }
  else if (sample) loadSplat(sample);
}
