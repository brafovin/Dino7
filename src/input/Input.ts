// Eingabe: Tastatur (frei belegbar) und Gamepad (Standard-Mapping), inkl. Vibration.
import { clamp } from '../shared/math';
import type { Action, Settings } from '../settings';

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: number;
  lookBack: boolean;
}

export type EdgeAction = 'shiftUp' | 'shiftDown' | 'camera' | 'reset' | 'pause';

export class Input {
  private keys = new Set<string>();
  private edges = new Set<EdgeAction>();
  private settings: Settings;
  private steerValue = 0;
  private throttleValue = 0;
  private brakeValue = 0;
  device: 'keyboard' | 'gamepad' = 'keyboard';
  private gpPrevButtons: boolean[] = [];
  private captureCb: ((code: string) => void) | null = null;
  /** Rennen aktiv: Standardverhalten (Scrollen etc.) für belegte Tasten unterdrücken */
  captureGameKeys = false;
  private readonly onDown = (e: KeyboardEvent) => this.handleKey(e, true);
  private readonly onUp = (e: KeyboardEvent) => this.handleKey(e, false);
  private readonly onBlur = () => this.keys.clear();
  private gamepadConnected = false;

  constructor(settings: Settings) {
    this.settings = settings;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', () => (this.gamepadConnected = true));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadConnected = this.findPad() !== null));
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
  }

  setSettings(s: Settings): void {
    this.settings = s;
  }

  /** Nächste gedrückte Taste abfangen (für die Tastenbelegung). */
  captureNextKey(cb: (code: string) => void): void {
    this.captureCb = cb;
  }

  cancelCapture(): void {
    this.captureCb = null;
  }

  private actionFor(code: string): Action | null {
    const b = this.settings.controls.bindings;
    for (const a of Object.keys(b) as Action[]) if (b[a].includes(code)) return a;
    return null;
  }

  private handleKey(e: KeyboardEvent, down: boolean): void {
    if (this.captureCb && down) {
      e.preventDefault();
      const cb = this.captureCb;
      this.captureCb = null;
      cb(e.code);
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    const action = this.actionFor(e.code);
    if (action && this.captureGameKeys) e.preventDefault();
    if (down) {
      if (!this.keys.has(e.code) && action) {
        if (action === 'shiftUp' || action === 'shiftDown' || action === 'camera' || action === 'reset' || action === 'pause') this.edges.add(action);
      }
      this.keys.add(e.code);
      this.device = 'keyboard';
    } else {
      this.keys.delete(e.code);
    }
  }

  private held(a: Action): boolean {
    for (const k of this.settings.controls.bindings[a]) if (this.keys.has(k)) return true;
    return false;
  }

  private findPad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  hasGamepad(): boolean {
    return this.gamepadConnected || this.findPad() !== null;
  }

  /** Einmal pro Frame aufrufen. */
  poll(dt: number, out: DriveInput): DriveInput {
    const c = this.settings.controls;
    const pad = this.findPad();
    let gpSteer = 0;
    let gpThrottle = 0;
    let gpBrake = 0;
    let gpHand = 0;
    let gpLook = false;
    let gpActive = false;
    if (pad) {
      const dz = c.deadzone;
      const ax = pad.axes[0] ?? 0;
      const mag = Math.abs(ax) < dz ? 0 : (Math.abs(ax) - dz) / (1 - dz);
      gpSteer = -Math.sign(ax) * Math.pow(mag, c.steerLinearity);
      gpThrottle = pad.buttons[7]?.value ?? 0;
      gpBrake = pad.buttons[6]?.value ?? 0;
      gpHand = pad.buttons[0]?.pressed ? 1 : 0;
      gpLook = !!pad.buttons[3]?.pressed && false;
      const b = pad.buttons.map((x) => x.pressed);
      const edge = (i: number) => b[i] && !this.gpPrevButtons[i];
      if (edge(5)) this.edges.add('shiftUp');
      if (edge(4)) this.edges.add('shiftDown');
      if (edge(3)) this.edges.add('camera');
      if (edge(2)) this.edges.add('reset');
      if (edge(9) || edge(8)) this.edges.add('pause');
      gpLook = !!b[1];
      this.gpPrevButtons = b;
      gpActive = Math.abs(gpSteer) > 0.02 || gpThrottle > 0.02 || gpBrake > 0.02 || b.some(Boolean);
      if (gpActive) this.device = 'gamepad';
    }

    // Tastatur mit Rampen (digital -> analog)
    const kbSteerTarget = (this.held('left') ? 1 : 0) - (this.held('right') ? 1 : 0);
    const sens = c.steerSensitivity;
    const rateIn = (1.6 + 2.6 * sens) * dt;
    const rateOut = (3.5 + 3 * sens) * dt;
    if (kbSteerTarget === 0) this.steerValue = this.approach(this.steerValue, 0, rateOut);
    else if (Math.sign(kbSteerTarget) !== Math.sign(this.steerValue) && this.steerValue !== 0)
      this.steerValue = this.approach(this.steerValue, kbSteerTarget, rateOut + rateIn);
    else this.steerValue = this.approach(this.steerValue, kbSteerTarget, rateIn);
    this.throttleValue = this.approach(this.throttleValue, this.held('throttle') ? 1 : 0, 7 * dt);
    this.brakeValue = this.approach(this.brakeValue, this.held('brake') ? 1 : 0, 12 * dt);

    if (this.device === 'gamepad' && pad) {
      out.steer = clamp(gpSteer * (0.6 + 0.4 * sens), -1, 1);
      out.throttle = Math.max(gpThrottle, this.throttleValue);
      out.brake = Math.max(gpBrake, this.brakeValue);
      out.handbrake = Math.max(gpHand, this.held('handbrake') ? 1 : 0);
      out.lookBack = gpLook || this.held('lookBack');
    } else {
      out.steer = this.steerValue;
      out.throttle = this.throttleValue;
      out.brake = this.brakeValue;
      out.handbrake = this.held('handbrake') ? 1 : 0;
      out.lookBack = this.held('lookBack');
    }
    return out;
  }

  private approach(v: number, t: number, d: number): number {
    return v < t ? Math.min(t, v + d) : Math.max(t, v - d);
  }

  /** Flanken-Aktion abholen (einmalig). */
  consume(a: EdgeAction): boolean {
    if (this.edges.has(a)) {
      this.edges.delete(a);
      return true;
    }
    return false;
  }

  clearEdges(): void {
    this.edges.clear();
  }

  /** Vibration (nur wenn vom Gamepad unterstützt und aktiviert). */
  rumble(strong: number, weak: number, ms: number): void {
    if (!this.settings.controls.vibration || this.device !== 'gamepad') return;
    const pad = this.findPad() as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null;
    const act = pad?.vibrationActuator;
    if (act && typeof act.playEffect === 'function') {
      act.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => undefined);
    }
  }

  canVibrate(): boolean {
    const pad = this.findPad() as (Gamepad & { vibrationActuator?: unknown }) | null;
    return !!pad?.vibrationActuator;
  }
}
