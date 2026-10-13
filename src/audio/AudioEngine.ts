// Prozedural synthetisierter Sound über die WebAudio-API (keine Audiodateien nötig).
import { clamp } from '../shared/math';

export interface EngineSoundParams {
  rpm: number;
  throttle: number;
  speed: number;
  slip: number;
  lockup: number;
  wheelspin: number;
  brake: number;
  curb: number;
  offTrack: number;
  limiter: boolean;
  scrape: number;
}

interface Voice {
  oscs: OscillatorNode[];
  gains: GainNode[];
  filter: BiquadFilterNode;
  out: GainNode;
  panner?: PannerNode;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private fxBus!: GainNode;
  private ambBus!: GainNode;
  private player: Voice | null = null;
  private intakeGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private tyreGain!: GainNode;
  private tyreFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private brakeGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleOsc!: OscillatorNode;
  private gravelGain!: GainNode;
  private scrapeGain!: GainNode;
  private crowdGain!: GainNode;
  private rainGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private opponents: Voice[] = [];
  private popTimer = 0;
  private volumes = { master: 0.8, engine: 0.8, ambient: 0.6, effects: 0.8 };
  private started = false;
  private muted = false;

  /** Muss nach einer Benutzerinteraktion aufgerufen werden. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.engineBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.ambBus = ctx.createGain();
    this.engineBus.connect(this.master);
    this.fxBus.connect(this.master);
    this.ambBus.connect(this.master);
    // Rauschpuffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.player = this.makeVoice(true);
    this.player.out.connect(this.engineBus);
    // Ansaug-/Rauschanteil
    [this.intakeGain, this.intakeFilter] = this.noiseChain('bandpass', 1800, 1.2, this.engineBus);
    // Reifen
    [this.tyreGain, this.tyreFilter] = this.noiseChain('bandpass', 1100, 7, this.fxBus);
    // Wind
    [this.windGain, this.windFilter] = this.noiseChain('lowpass', 700, 0.7, this.ambBus);
    // Bremse
    [this.brakeGain] = this.noiseChain('highpass', 3200, 0.8, this.fxBus);
    // Kies/Gras
    [this.gravelGain] = this.noiseChain('lowpass', 500, 0.6, this.fxBus);
    // Schleifen an der Wand
    [this.scrapeGain] = this.noiseChain('bandpass', 2600, 3, this.fxBus);
    // Publikum
    [this.crowdGain] = this.noiseChain('bandpass', 600, 0.5, this.ambBus);
    // Regen
    [this.rainGain] = this.noiseChain('highpass', 1500, 0.4, this.ambBus);
    // Curb-Rumpeln
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'square';
    this.rumbleOsc.frequency.value = 38;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 160;
    this.rumbleOsc.connect(rf).connect(this.rumbleGain).connect(this.fxBus);
    this.rumbleOsc.start();
    // Gegner-Stimmen
    for (let k = 0; k < 3; k++) {
      const v = this.makeVoice(false);
      v.panner = ctx.createPanner();
      v.panner.panningModel = 'HRTF';
      v.panner.distanceModel = 'inverse';
      v.panner.refDistance = 8;
      v.panner.maxDistance = 400;
      v.panner.rolloffFactor = 1.4;
      v.out.connect(v.panner).connect(this.engineBus);
      this.opponents.push(v);
    }
    this.applyVolumes();
    this.started = true;
  }

  private noiseChain(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): [GainNode, BiquadFilterNode] {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(dest);
    src.start(0, Math.random());
    return [g, f];
  }

  private makeVoice(rich: boolean): Voice {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2000;
    filter.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    const out = ctx.createGain();
    out.gain.value = 0;
    const defs: [OscillatorType, number, number][] = rich
      ? [
          ['sawtooth', 1, 0.5],
          ['square', 0.5, 0.35],
          ['sawtooth', 2, 0.22],
          ['triangle', 3, 0.12],
          ['sawtooth', 1.5, 0.1],
        ]
      : [
          ['sawtooth', 1, 0.5],
          ['square', 0.5, 0.25],
          ['sawtooth', 2, 0.15],
        ];
    const oscs: OscillatorNode[] = [];
    const gains: GainNode[] = [];
    for (const [type, mult, g] of defs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 100 * mult;
      o.detune.value = (Math.random() - 0.5) * 12;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(shaper);
      o.start();
      oscs.push(o);
      gains.push(gn);
      (o as OscillatorNode & { mult?: number }).mult = mult;
    }
    shaper.connect(filter).connect(out);
    return { oscs, gains, filter, out };
  }

  setVolumes(v: { master: number; engine: number; ambient: number; effects: number }): void {
    this.volumes = { ...v };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.05);
    this.engineBus.gain.setTargetAtTime(this.volumes.engine * 0.55, t, 0.05);
    this.fxBus.gain.setTargetAtTime(this.volumes.effects * 0.7, t, 0.05);
    this.ambBus.gain.setTargetAtTime(this.volumes.ambient * 0.6, t, 0.05);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
  }

  /** Alle Fahrgeräusche ausblenden (Menüs/Pause). */
  silence(): void {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    for (const g of [this.player!.out, this.intakeGain, this.tyreGain, this.windGain, this.brakeGain, this.rumbleGain, this.gravelGain, this.scrapeGain, this.crowdGain, this.rainGain]) g.gain.setTargetAtTime(0, t, 0.08);
    for (const o of this.opponents) o.out.gain.setTargetAtTime(0, t, 0.08);
  }

  private setVoice(v: Voice, rpm: number, load: number, gain: number, t: number, doppler = 1): void {
    // V6-Viertakter: Zündfrequenz = rpm/60 * 3
    const f0 = (rpm / 60) * 3 * doppler;
    for (const o of v.oscs) {
      const mult = (o as OscillatorNode & { mult?: number }).mult ?? 1;
      o.frequency.setTargetAtTime(Math.max(20, f0 * mult), t, 0.012);
    }
    v.filter.frequency.setTargetAtTime(700 + load * 4200 + rpm * 0.12, t, 0.03);
    v.out.gain.setTargetAtTime(gain, t, 0.03);
  }

  update(dt: number, p: EngineSoundParams, env: { crowd: number; rain: boolean }): void {
    if (!this.ctx || !this.started || !this.player) return;
    const t = this.ctx.currentTime;
    const load = clamp(p.throttle, 0, 1);
    const rpm = p.limiter ? p.rpm * (0.97 + Math.random() * 0.04) : p.rpm;
    this.setVoice(this.player, rpm, load, 0.16 + load * 0.2, t);
    this.intakeGain.gain.setTargetAtTime(0.02 + load * 0.07 * (rpm / 13000), t, 0.04);
    this.intakeFilter.frequency.setTargetAtTime(900 + rpm * 0.25, t, 0.05);
    // Fehlzündungen beim Lupfen
    this.popTimer -= dt;
    if (load < 0.1 && rpm > 8500 && this.popTimer <= 0 && Math.random() < 0.25) {
      this.popTimer = 0.05 + Math.random() * 0.12;
      this.burst(0.18 + Math.random() * 0.15, 900, 0.05, this.engineBus);
    }
    const slip = clamp(Math.max(p.slip, p.lockup * 1.2, p.wheelspin), 0, 1);
    this.tyreGain.gain.setTargetAtTime(slip * 0.45 * clamp(p.speed / 8, 0, 1) * (1 - p.offTrack), t, 0.04);
    this.tyreFilter.frequency.setTargetAtTime(850 + slip * 500 + Math.sin(t * 30) * 60, t, 0.05);
    const v = p.speed / 90;
    this.windGain.gain.setTargetAtTime(Math.min(0.6, v * v * 0.5), t, 0.1);
    this.windFilter.frequency.setTargetAtTime(400 + v * 1600, t, 0.1);
    this.brakeGain.gain.setTargetAtTime(p.brake > 0.6 && p.speed > 15 ? (p.brake - 0.6) * 0.12 : 0, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime(p.curb > 0 ? 0.35 * clamp(p.speed / 30, 0, 1) : 0, t, 0.02);
    this.rumbleOsc.frequency.setTargetAtTime(20 + p.speed * 1.4, t, 0.05);
    this.gravelGain.gain.setTargetAtTime(p.offTrack * 0.5 * clamp(p.speed / 10, 0, 1), t, 0.05);
    this.scrapeGain.gain.setTargetAtTime(p.scrape > 0.5 && p.speed > 3 ? 0.25 : 0, t, 0.03);
    this.crowdGain.gain.setTargetAtTime(env.crowd * 0.08, t, 0.5);
    this.rainGain.gain.setTargetAtTime(env.rain ? 0.12 : 0, t, 0.5);
  }

  /** Gegnerstimmen: Position relativ zum Hörer (Kamera). */
  updateOpponents(listener: { x: number; y: number; z: number; fx: number; fy: number; fz: number }, cars: { x: number; y: number; z: number; rpm: number; throttle: number; radialVel: number }[]): void {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(listener.x, t, 0.02);
      L.positionY.setTargetAtTime(listener.y, t, 0.02);
      L.positionZ.setTargetAtTime(listener.z, t, 0.02);
      L.forwardX.setTargetAtTime(listener.fx, t, 0.02);
      L.forwardY.setTargetAtTime(listener.fy, t, 0.02);
      L.forwardZ.setTargetAtTime(listener.fz, t, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      (L as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(listener.x, listener.y, listener.z);
    }
    this.opponents.forEach((v, k) => {
      const c = cars[k];
      if (!c) {
        v.out.gain.setTargetAtTime(0, t, 0.1);
        return;
      }
      const doppler = clamp(343 / (343 + c.radialVel), 0.8, 1.25);
      this.setVoice(v, c.rpm, c.throttle, 0.22 + c.throttle * 0.18, t, doppler);
      if (v.panner!.positionX) {
        v.panner!.positionX.setTargetAtTime(c.x, t, 0.02);
        v.panner!.positionY.setTargetAtTime(c.y, t, 0.02);
        v.panner!.positionZ.setTargetAtTime(c.z, t, 0.02);
      } else {
        (v.panner as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(c.x, c.y, c.z);
      }
    });
  }

  private burst(gain: number, freq: number, dur: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** Aufprallgeräusch. */
  impact(strength: number): void {
    if (!this.ctx || !this.started) return;
    const s = clamp(strength / 20, 0.1, 1);
    this.burst(0.8 * s, 300, 0.25 + s * 0.2, this.fxBus);
    this.burst(0.4 * s, 2500, 0.15, this.fxBus);
    // dumpfer Schlag
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = 70;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.6 * s, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.fxBus);
    o.start(t);
    o.stop(t + 0.35);
  }

  /** Schaltgeräusch. */
  shift(): void {
    if (!this.ctx || !this.started) return;
    this.burst(0.12, 1400, 0.04, this.engineBus);
  }

  /** Kurzer Signalton (Startampel, Menü). */
  beep(freq = 880, dur = 0.12, gain = 0.15): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.fxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Siegerehrung: kurze Fanfare, Jubel der Zuschauer und Applaus. */
  celebrate(): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const note = (freq: number, at: number, dur: number, gain: number) => {
      for (const [type, mult, g] of [
        ['triangle', 1, 1],
        ['square', 0.5, 0.18],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq * mult;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2600;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0 + at);
        env.gain.exponentialRampToValueAtTime(gain * g, t0 + at + 0.025);
        env.gain.setTargetAtTime(gain * g * 0.6, t0 + at + 0.06, 0.08);
        env.gain.setTargetAtTime(0.0001, t0 + at + dur, 0.12);
        o.connect(lp).connect(env).connect(this.fxBus);
        o.start(t0 + at);
        o.stop(t0 + at + dur + 0.8);
      }
    };
    // C – E – G – C' … Schlussakkord
    const seq: [number, number, number][] = [
      [523.25, 0, 0.16],
      [659.25, 0.18, 0.16],
      [783.99, 0.36, 0.16],
      [1046.5, 0.54, 0.34],
      [783.99, 0.92, 0.14],
      [1046.5, 1.08, 1.3],
    ];
    for (const [f, at, d] of seq) note(f, at, d, 0.1);
    for (const f of [523.25, 659.25, 783.99]) note(f, 1.08, 1.3, 0.05);
    // Jubel: gefiltertes Rauschen, an- und abschwellend
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.32, t0 + 1.4);
    g.gain.setTargetAtTime(0.18, t0 + 3, 1.2);
    g.gain.setTargetAtTime(0.0001, t0 + 9, 1.5);
    src.connect(bp).connect(g).connect(this.ambBus);
    src.start(t0);
    src.stop(t0 + 16);
    // Applaus: viele kurze Klatscher
    for (let k = 0; k < 140; k++) {
      const at = 0.4 + Math.random() * 8;
      setTimeout(() => {
        if (this.ctx === ctx) this.burst(0.05 + Math.random() * 0.06, 1500 + Math.random() * 1800, 0.05, this.ambBus);
      }, at * 1000);
    }
  }

  dispose(): void {
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.started = false;
  }
}
