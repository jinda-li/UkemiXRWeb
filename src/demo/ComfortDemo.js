// Booth demo: the avatar walks on its own and the camera alternates between
// UkemiXR's steady cuts (tech ON) and a plain first-person follow camera
// (tech OFF), PHASE_SECONDS each, so anyone who puts the headset on feels the
// difference without touching a controller.
//
// The walk is scripted, not a fixed path: every few frames it probes the
// collision world ahead and steers towards open space, with a slow wander so
// the route curves. In the OFF phase the view turns smoothly with the walk
// (what an ordinary first-person camera does, and what makes people sick);
// in the ON phase the camera never rotates on its own, it snap-turns when
// the walk has drifted too far from the view.

import * as THREE from 'three';
import { deltaAngle, yawForward } from '../locomotion/CameraRig.js';

export const PHASE_SECONDS = 5;
export const PHASES = [
  { follow: 'discrete', tech: true, title: 'UkemiXR ON', sub: 'Steady cuts · no motion sickness' },
  { follow: 'firstPerson', tech: false, title: 'UkemiXR OFF', sub: 'Ordinary first-person camera' },
];

const DEG = Math.PI / 180;
const PROBES = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((d) => d * DEG);

export class ComfortDemo {
  // respawn(): put the player back at the scene's start.
  constructor({ player, cameraRig, respawn }) {
    this.player = player;
    this.cameraRig = cameraRig;
    this.respawn = respawn;
    this.active = false;
    this.stickMagnitude = 0.6;
    this.startDelay = 0.6; // stand still for a moment after each restart
    this.turnRate = 1.1; // rad/s the walk heading may turn
    this.viewTurnRate = 2.5; // OFF phase: how fast the view chases the heading
    this.snapThreshold = 55 * DEG; // ON phase: snap once the walk is this far off
    this.onPhase = null; // (phase, index) => void
    this._reset();
  }

  get phaseIndex() { return this._phase; }
  get phase() { return PHASES[this._phase]; }
  get follow() { return this.phase.follow; }
  // Seconds left in the current phase.
  get remaining() { return Math.max(0, PHASE_SECONDS - this._t); }

  start() {
    this.active = true;
    this.restart();
  }

  stop() {
    this.active = false;
  }

  // Back to the first phase, from the start spot (a new visitor).
  restart() {
    this._reset();
    this.respawn();
    this._heading = this.cameraRig.hmdYaw();
    this.onPhase?.(this.phase, this._phase);
  }

  nextPhase() {
    this._phase = (this._phase + 1) % PHASES.length;
    this._t = 0;
    this.onPhase?.(this.phase, this._phase);
  }

  _reset() {
    this._phase = 0;
    this._t = 0;
    this._clock = 0;
    this._target = 0;
    this._heading = 0;
    this._probeIn = 0;
    this._stuck = 0;
    this._snapCooldown = 0;
  }

  // One frame: advances the timeline and returns the raw input frame
  // (PlayerInput format) that walks the avatar.
  update(dt) {
    this._t += dt;
    this._clock += dt;
    if (this._t >= PHASE_SECONDS) this.nextPhase();
    const raw = { move: { x: 0, y: 0 }, right: { x: 0, y: 0 }, a: false, b: false };
    if (this._clock < this.startDelay) return raw;

    const p = this.player, rig = this.cameraRig;
    if (p.world && (this._probeIn -= dt) <= 0) {
      this._probeIn = 0.12;
      this._target = this._pickHeading();
    }
    // Stuck against something the probes missed: take the most open way
    // that is not straight ahead.
    if (p.isLocomoting && p.speed < 0.25) this._stuck += dt;
    else this._stuck = 0;
    if (this._stuck > 0.3 && p.world) {
      this._target = this._heading = this._pickHeading(this._heading + Math.PI, 3);
      this._stuck = 0;
      this._probeIn = 0.5;
    }
    const d = deltaAngle(this._heading, this._target);
    this._heading += Math.sign(d) * Math.min(Math.abs(d), this.turnRate * dt);

    const viewYaw = rig.hmdYaw();
    if (this.phase.follow === 'firstPerson') {
      // Ordinary first-person: the camera turns with the walk, continuously.
      const turn = deltaAngle(viewYaw, this._heading);
      const k = 1 - Math.exp(-this.viewTurnRate * dt);
      rig._rotateRigAroundPivot(rig.hmdPosition(new THREE.Vector3()), turn * k);
    } else if ((this._snapCooldown -= dt) <= 0 && p.isLocomoting) {
      const off = deltaAngle(viewYaw, this._heading);
      if (Math.abs(off) > this.snapThreshold) {
        if (off > 0) rig.snapLeft(); else rig.snapRight();
        this._snapCooldown = 1.2;
      }
    }

    // World heading -> stick in the frame of the current view yaw.
    const yaw = rig.hmdYaw();
    const fwd = yawForward(yaw, new THREE.Vector3());
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const dir = yawForward(this._heading, new THREE.Vector3());
    raw.move.x = dir.dot(right) * this.stickMagnitude;
    raw.move.y = dir.dot(fwd) * this.stickMagnitude;
    return raw;
  }

  // The probe direction closest to the wandering preference that has room
  // to walk; the most open one if none does.
  _pickHeading(prefer = this._heading + 0.5 * Math.sin(this._clock * 0.45), maxProbe = PROBES.length) {
    const w = this.player.world, b = this.player.body;
    // Rays across the body's width and height, so a table edge or a low
    // armrest counts.
    const clearance = (yaw) => {
      const f = yawForward(yaw, new THREE.Vector3());
      let min = Infinity;
      for (const side of [-0.25, 0, 0.25]) {
        const ox = b.x - f.z * side, oz = b.z + f.x * side;
        for (const h of [0.3, 0.8, 1.4]) min = Math.min(min, w.raycast(ox, b.y + h, oz, f.x, 0, f.z, 4));
      }
      return min;
    };
    let best = prefer, bestD = -1;
    for (const off of PROBES.slice(0, maxProbe * 2 - 1)) {
      const yaw = prefer + off;
      const d = clearance(yaw);
      if (d >= 2) return yaw;
      if (d > bestD) { bestD = d; best = yaw; }
    }
    return best;
  }
}
