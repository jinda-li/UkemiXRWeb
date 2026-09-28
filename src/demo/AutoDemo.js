// Auto demo (booth mode): the avatar walks a fixed route by itself while the
// camera alternates between UkemiXR's steady cuts (tech ON, 8 s) and a plain
// first-person follow camera (tech OFF, 5 s). Each phase walks the same route
// from the same start (OFF only its first part), then teleports back, so
// anyone who puts the headset on feels the difference on identical motion
// without touching a controller.
//
// The walk is stop-and-go (WALK_PATTERN): every start and stop is a moment
// the two cameras handle differently (ON cuts back into the head on a stop
// and lets the body walk out ahead on a start; OFF just lurches along).
//
// The route is fixed per scene: when a scene loads it is traced once from the
// spawn through the collision world (probe ahead, steer to open space, with a
// gentle deterministic curve) and stored as timed samples. At run time the
// stick is set each frame to exactly the step to the next sample (and let go
// during the stops), so the avatar walks the same path at the same pace every
// time. In the OFF phase the view turns smoothly with the walk (what an
// ordinary first-person camera does, and what makes people sick); in the ON
// phase the camera never rotates on its own, it snap-turns when the walk has
// drifted too far from the view.

import * as THREE from 'three';
import { deltaAngle, yawForward } from '../locomotion/CameraRig.js';

export const PHASES = [
  { follow: 'discrete', tech: true, seconds: 8 },
  { follow: 'firstPerson', tech: false, seconds: 5 },
];
const LONGEST = Math.max(...PHASES.map((p) => p.seconds));
// Seconds of walking and standing, alternating, starting with a walk; repeats.
const WALK_PATTERN = [1.7, 1.0, 1.5, 1.1];

const DEG = Math.PI / 180;
const TRACE_DT = 1 / 30;
const PROBES = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((d) => d * DEG);

export class AutoDemo {
  // start(): { x, y, z, yaw } of the scene's spawn (feet, view yaw) or null.
  // respawn(): put the player back there.
  constructor({ player, cameraRig, start, respawn }) {
    this.player = player;
    this.cameraRig = cameraRig;
    this.start = start;
    this.respawn = respawn;
    this.active = false;
    this.stickMagnitude = 0.6;
    this.startDelay = 0.6; // stand still for a moment at the start of each run
    this.routeSeconds = LONGEST - this.startDelay - 0.4; // route length in time, stops included
    this.turnRate = 3; // rad/s the walk heading may turn while pursuing the route
    this.viewTurnRate = 2.5; // OFF phase: how fast the view chases the heading
    this.snapThreshold = 55 * DEG; // ON phase: snap once the walk is this far off
    this.onPhase = null; // (phase, index) => void
    this.route = null; // { world, yaw, dt, points: [{x, z, walk}] } sampled every dt
    this.lookAhead = 0.3; // s, for the walk direction the view follows
    this._phase = 0;
    this._t = 0;
    this._resetRun();
  }

  get phaseIndex() { return this._phase; }
  get phase() { return PHASES[this._phase]; }
  get follow() { return this.phase.follow; }
  // Seconds left in the current phase.
  get remaining() { return Math.max(0, this.phase.seconds - this._t); }

  play() {
    this.active = true;
    this.restart();
  }

  stop() {
    this.active = false;
  }

  // Back to the first phase (a new visitor).
  restart() {
    this._phase = 0;
    this._beginRun();
  }

  nextPhase() {
    this._phase = (this._phase + 1) % PHASES.length;
    this._beginRun();
  }

  // Teleport to the start, face along the route, walk it from the top.
  _beginRun() {
    this._t = 0;
    this._resetRun();
    this.respawn();
    const route = this._ensureRoute();
    if (route) {
      const rig = this.cameraRig;
      rig._rotateRigAroundPivot(rig.hmdPosition(new THREE.Vector3()), deltaAngle(rig.hmdYaw(), route.yaw));
      rig._viewYaw = rig.hmdYaw();
      this._heading = route.yaw;
    }
    this.onPhase?.(this.phase, this._phase);
  }

  _resetRun() {
    this._clock = 0;
    this._heading = 0;
    this._snapCooldown = 0;
  }

  _ensureRoute() {
    const world = this.player.world;
    if (!world) return null;
    if (this.route?.world !== world) {
      const s = this.start();
      this.route = s ? { world, yaw: s.yaw, dt: TRACE_DT, points: this._trace(world, s) } : null;
    }
    return this.route;
  }

  // One frame: advances the timeline and returns the raw input frame
  // (PlayerInput format) that walks the avatar.
  update(dt) {
    this._t += dt;
    this._clock += dt;
    if (this._t >= this.phase.seconds) this.nextPhase();
    const raw = { move: { x: 0, y: 0 }, right: { x: 0, y: 0 }, a: false, b: false };
    const route = this._ensureRoute();
    const runT = this._clock - this.startDelay;
    if (!route || runT < 0) return raw;
    const pts = route.points;
    const last = pts.length - 1;
    const p = this.player, b = p.body, rig = this.cameraRig;
    const at = (t) => {
      const f = THREE.MathUtils.clamp(t / route.dt, 0, last);
      const k = Math.floor(f), u = f - k, a = pts[k], c = pts[Math.min(last, k + 1)];
      return { x: a.x + (c.x - a.x) * u, z: a.z + (c.z - a.z) * u };
    };
    // A stop: let go of the stick, stand where the route stands.
    if (!pts[Math.min(last, Math.floor(runT / route.dt))].walk) return raw;
    // The step that lands on the route one frame from now.
    const next = at(runT + dt);
    const step = new THREE.Vector3(next.x - b.x, 0, next.z - b.z);
    if (runT >= last * route.dt && step.length() < 0.05) return raw; // done: stand until the phase ends
    // Where the walk is heading (for the view), from the route itself.
    const ahead = at(runT + this.lookAhead), here = at(runT);
    if (Math.hypot(ahead.x - here.x, ahead.z - here.z) > 0.05) {
      const want = Math.atan2(-(ahead.x - here.x), -(ahead.z - here.z));
      const d = deltaAngle(this._heading, want);
      this._heading += Math.sign(d) * Math.min(Math.abs(d), this.turnRate * dt);
    }

    const viewYaw = rig.hmdYaw();
    if (this.phase.follow === 'firstPerson') {
      // Ordinary first-person: the camera turns with the walk, continuously.
      const k = 1 - Math.exp(-this.viewTurnRate * dt);
      rig._rotateRigAroundPivot(rig.hmdPosition(new THREE.Vector3()), deltaAngle(viewYaw, this._heading) * k);
    } else if ((this._snapCooldown -= dt) <= 0 && p.isLocomoting) {
      const off = deltaAngle(viewYaw, this._heading);
      if (Math.abs(off) > this.snapThreshold) {
        if (off > 0) rig.snapLeft(); else rig.snapRight();
        this._snapCooldown = 1.2;
      }
    }

    // World step -> stick in the frame of the current view yaw.
    step.divideScalar(p.moveSpeed * Math.max(dt, 1e-4));
    const len = step.length();
    // Never dip under PlayerInput's release threshold mid-route (that would
    // end the walk and cut back into the head), and never over full stick.
    if (len > 1) step.normalize();
    else if (len > 1e-4 && len < 0.22) step.multiplyScalar(0.22 / len);
    const yaw = rig.hmdYaw();
    const fwd = yawForward(yaw, new THREE.Vector3());
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    raw.move.x = step.dot(right);
    raw.move.y = step.dot(fwd);
    return raw;
  }

  // Walk a virtual body from the spawn for routeSeconds (stopping as
  // WALK_PATTERN says), steering to open space, sampling its position every
  // TRACE_DT. Deterministic for a scene.
  _trace(world, s) {
    const body = { x: s.x, y: s.y, z: s.z };
    world.resetTrail(body);
    const speed = this.player.moveSpeed * this.stickMagnitude;
    const dt = TRACE_DT;
    let heading = s.yaw, target = s.yaw;
    const points = [{ x: body.x, z: body.z, walk: true }];
    const period = WALK_PATTERN.reduce((a, b) => a + b, 0);
    const walking = (t) => {
      let u = t % period;
      for (let k = 0; k < WALK_PATTERN.length; ++k) {
        if (u < WALK_PATTERN[k]) return k % 2 === 0;
        u -= WALK_PATTERN[k];
      }
      return true;
    };
    for (let i = 1, t = 0; t < this.routeSeconds; ++i, t += dt) {
      if (!walking(t)) {
        points.push({ x: body.x, z: body.z, walk: false });
        continue;
      }
      if (i % 4 === 0) {
        // A gentle S-curve so the OFF phase has to turn, and turning is
        // where an ordinary first-person camera hurts most.
        target = this._openHeading(world, body, heading + 0.6 * Math.sin(t * 1.1));
      }
      const d = deltaAngle(heading, target);
      heading += Math.sign(d) * Math.min(Math.abs(d), 1.4 * dt);
      const f = yawForward(heading, new THREE.Vector3());
      const bx = body.x, bz = body.z;
      world.moveAndSlide(body, f.x * speed * dt, f.z * speed * dt);
      // Blocked (or only scraping along something): turn to open space now
      // rather than grinding into it.
      if (Math.hypot(body.x - bx, body.z - bz) < speed * dt * 0.6) {
        heading = target = this._openHeading(world, body, heading, PROBES.length, 1.2);
      }
      points.push({ x: body.x, z: body.z, walk: true });
    }
    world.resetTrail(s);
    return points;
  }

  // The probe direction closest to `prefer` that has room to walk; the most
  // open one if none does. Rays across the body's width and height, so a
  // table edge or a low armrest counts.
  _openHeading(world, body, prefer, maxProbe = PROBES.length, room = 2) {
    const clearance = (yaw) => {
      const f = yawForward(yaw, new THREE.Vector3());
      let min = Infinity;
      for (const side of [-0.25, 0, 0.25]) {
        const ox = body.x - f.z * side, oz = body.z + f.x * side;
        for (const h of [0.3, 0.8, 1.4]) min = Math.min(min, world.raycast(ox, body.y + h, oz, f.x, 0, f.z, 4));
      }
      return min;
    };
    let best = prefer, bestD = -1;
    for (const off of PROBES.slice(0, maxProbe * 2 - 1)) {
      const yaw = prefer + off;
      const dist = clearance(yaw);
      if (dist >= room) return yaw;
      if (dist > bestD) { bestD = dist; best = yaw; }
    }
    return best;
  }
}
