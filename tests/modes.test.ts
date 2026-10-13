// Tests der Spielmodi und Rennregeln (headless): Qualifying, Zeitfahren, Training, Boxenstopps,
// Abkürzungsstrafe, automatische Rücksetzung und Rennende.
// Aufruf: npx tsx tests/modes.test.ts
import { AIDriver } from '../src/shared/ai';
import { emptyInput } from '../src/shared/carPhysics';
import type { SessionConfig } from '../src/sim/config';
import { RaceSession, type SessionEvent } from '../src/sim/RaceSession';
import { LapTrace } from '../src/sim/LapTrace';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

const base: SessionConfig = {
  mode: 'grandprix',
  trackId: 'zandvoort',
  laps: 2,
  weather: 'dry',
  difficulty: 'normal',
  playerDriverId: 'norris',
  aiCount: 7,
  startMode: 'random',
  wearScale: 1,
  startCompound: 'soft',
  transmission: 'auto',
  assists: { tc: 'high', abs: true, line: 'full', steering: false, brake: false, autoReset: true },
  seed: 99,
};
const dt = 1 / 120;

/** Fährt die Sitzung mit einem Autopiloten für den Spieler. */
function drive(sess: RaceSession, seconds: number, grip = 0.9, until?: () => boolean, onEvent?: (e: SessionEvent) => void, steerOverride?: (t: number) => Partial<ReturnType<typeof emptyInput>> | null): void {
  const pilot = new AIDriver(sess.player.car, sess.track, sess.line, { grip, brake: grip * 0.97, racecraft: 0.5, consistency: 1 }, sess.cfg.weather, 3);
  const t0 = sess.time;
  while (sess.time - t0 < seconds && !(until && until())) {
    const others = sess.cars.map((c) => ({ car: c.car, id: c.id }));
    let inp = pilot.update(dt, others, sess.player.id, sess.phase === 'racing');
    const ov = steerOverride?.(sess.time - t0);
    if (ov) inp = { ...inp, ...ov };
    sess.step(dt, inp);
    if (pilot.wantsReset) {
      sess.resetCar(sess.player);
      pilot.onReset();
    }
    for (const e of sess.drainEvents()) onEvent?.(e);
  }
}

// ------------------------------------------------------------------ Qualifying
console.log('▶ Qualifying');
{
  const q = new RaceSession({ ...base, startMode: 'qualifying' }, 'qualifying');
  check(q.cars.length === 1, 'Qualifying: Spieler allein auf der Strecke');
  drive(q, 400, 0.92, () => q.phase === 'finished');
  check(q.phase === 'finished', 'Qualifying endet nach Aufwärmrunde + 2 gezeiteten Runden');
  const rows = q.qualiResults ?? [];
  check(rows.length === 22, `Qualifying-Ergebnis mit 22 Fahrern (${rows.length})`);
  const me = rows.find((r) => r.driver.id === 'norris');
  check(!!me && me.time !== null, `Spielerzeit gewertet: P${me?.position} ${me?.time?.toFixed(3)} s`);
  check(rows.every((r, i) => i === 0 || (r.time ?? 1e9) >= (rows[i - 1].time ?? 1e9)), 'Ergebnis nach Zeit sortiert');
  // Startaufstellung gemäß Qualifying
  const grid = rows.map((r) => r.driver.id);
  const race = new RaceSession({ ...base, aiCount: 21 }, 'race', grid);
  check(race.cars[0].driver.id === grid[0] && race.player.position === (me?.position ?? -1), `Startaufstellung folgt dem Qualifying (Spieler P${race.player.position})`);
}

// ------------------------------------------------------------------ Zeitfahren
console.log('\n▶ Zeitfahren');
{
  const tt = new RaceSession({ ...base, mode: 'timetrial' }, 'timetrial');
  check(tt.cars.length === 1 && tt.phase === 'racing', 'Zeitfahren: allein, sofort fahrbereit');
  check(!tt.player.lap.timing, 'Zeitnahme läuft erst ab der Ziellinie');
  const laps: { t: number; valid: boolean }[] = [];
  const sectors: number[] = [];
  drive(tt, 300, 0.92, () => laps.length >= 2, (e) => {
    if (e.type === 'lap' && e.carId === tt.player.id) laps.push({ t: e.lapTime, valid: e.valid });
    if (e.type === 'sector' && e.carId === tt.player.id) sectors.push(e.split);
  });
  check(laps.length >= 2 && laps.every((l) => l.valid), `zwei gültige Runden (${laps.map((l) => l.t.toFixed(3)).join(', ')})`);
  check(sectors.length >= 4, 'Sektorzeiten werden gemessen');
  check(tt.player.lap.bestLap !== null && tt.player.lap.bestLap === Math.min(...laps.map((l) => l.t)), 'beste Runde gespeichert');
  // Abkürzen -> Runde ungültig
  const tt2 = new RaceSession({ ...base, mode: 'timetrial' }, 'timetrial');
  let invalidLap = false;
  let msg = '';
  drive(
    tt2,
    260,
    0.9,
    () => invalidLap,
    (e) => {
      if (e.type === 'lap' && !e.valid) invalidLap = true;
      if (e.type === 'message') msg = e.text;
    },
    (t) => (t > 25 && t < 27.5 ? { steerAngle: -0.25 } : null),
  );
  check(invalidLap, `Verlassen der Strecke macht die Runde ungültig („${msg}“)`);
}

// ------------------------------------------------------------------ Boxenstopp
console.log('\n▶ Boxenstopps');
{
  // KI-Strategie: hoher Verschleiß erzwingt Stopps
  const r = new RaceSession({ ...base, laps: 4, aiCount: 9, wearScale: 8 }, 'race');
  r.startCountdown();
  let pitIns = 0;
  let pitOuts = 0;
  drive(r, 600, 0.9, () => r.phase === 'finished', (e) => {
    if (e.type === 'pit' && e.stage === 'in') pitIns++;
    if (e.type === 'pit' && e.stage === 'out') pitOuts++;
  });
  const aiStops = r.cars.filter((c) => !c.isPlayer).reduce((a, c) => a + c.pitStops, 0);
  check(aiStops >= 3, `KI fährt bei Verschleiß an die Box (${aiStops} Stopps, ${pitIns} Einfahrten)`);
  check(pitOuts === pitIns, 'jeder Stopp wird abgeschlossen');
  const fresh = r.cars.filter((c) => c.pitStops > 0).every((c) => Math.max(...c.car.st.tyreWear) < 0.75);
  check(fresh, 'nach dem Stopp frische Reifen');
  check(r.phase === 'finished', 'Rennen mit Boxenstopps wird beendet');
  const res = r.results();
  check(res.some((x) => x.pitStops > 0), 'Stopps erscheinen im Ergebnis');

  // Spieler-Boxenstopp: Autopilot fährt gezielt in die eigene Box
  const p = new RaceSession({ ...base, laps: 3, aiCount: 0, wearScale: 3 }, 'race');
  p.startCountdown();
  p.player.nextCompound = 'hard';
  const pilot = new AIDriver(p.player.car, p.track, p.line, { grip: 0.9, brake: 0.87, racecraft: 0, consistency: 1 }, 'dry', 4);
  pilot.pitBox = p.track.pit.boxes[p.player.teamIndex % p.track.pit.boxes.length];
  let stopped = false;
  let limiterSeen = false;
  let maxPitSpeed = 0;
  for (let k = 0; k < 120 * 300 && !stopped; k++) {
    const inp = pilot.update(dt, [{ car: p.player.car, id: 0 }], 0, p.phase === 'racing');
    p.step(dt, inp);
    if (p.player.car.st.limiter) {
      limiterSeen = true;
      maxPitSpeed = Math.max(maxPitSpeed, p.player.car.st.vx);
    }
    for (const e of p.drainEvents()) if (e.type === 'pit' && e.stage === 'out') stopped = true;
    if (p.player.pitTimer > 0) pilot.pitBox = null;
  }
  check(stopped, 'Spieler-Boxenstopp in der eigenen Box durchgeführt');
  check(p.player.car.st.compound === 'hard', 'gewählte Reifenmischung montiert');
  check(limiterSeen && maxPitSpeed < 80 / 3.6 + 1.5, `Tempolimit in der Boxengasse (max. ${(maxPitSpeed * 3.6).toFixed(1)} km/h)`);
}

// ------------------------------------------------------------------ Strafen & Reset
console.log('\n▶ Strafen & automatische Rücksetzung');
{
  // Abkürzung durch eine Schikane (Monza, Variante del Rettifilo)
  const m = new RaceSession({ ...base, trackId: 'monza', laps: 2, aiCount: 0 }, 'race');
  m.startCountdown();
  // Bis kurz vor die erste Schikane fahren, dann geradeaus durch
  const chicane = m.track.corners.find((c) => c.name?.includes('Rettifilo'))!;
  const sChicane = chicane.start * m.track.spacing;
  let msgs: string[] = [];
  drive(
    m,
    60,
    0.9,
    () => m.player.penalty > 0 || m.player.progress > m.track.length,
    (e) => e.type === 'message' && msgs.push(e.text),
    () => {
      const ds = m.track.deltaS(m.player.car.st.s, sChicane);
      if (m.phase === 'racing' && ds < 60 && ds > -90) {
        // geradeaus auf die Tangente vor der Schikane zielen
        const st = m.player.car.st;
        const i = m.track.indexAt(sChicane - 60);
        const target = Math.atan2(m.track.tx[i], m.track.tz[i]);
        const err = Math.atan2(Math.sin(target - st.heading), Math.cos(target - st.heading));
        return { steerAngle: Math.max(-0.2, Math.min(0.2, err * 2)), throttle: 0.6, brake: 0 };
      }
      return null;
    },
  );
  check(m.player.penalty >= 5, `Abkürzen der Schikane wird bestraft (${m.player.penalty} s; ${msgs.filter((x) => /Abk|Strecken/.test(x)).join('; ')})`);

  // Auto-Reset: Fahrzeug auf Kies stehen lassen
  const z = new RaceSession({ ...base, aiCount: 0 }, 'practice');
  const st = z.player.car.st;
  const s0 = 600;
  const off = z.track.barrierAt(s0, true) - 3;
  z.player.car.placeAt(z.track, s0, off, 0);
  z.player.prevS = st.s;
  let resetEvt = false;
  for (let k = 0; k < 120 * 5; k++) {
    z.step(dt, emptyInput());
    for (const e of z.drainEvents()) if (e.type === 'reset') resetEvt = true;
  }
  check(resetEvt && Math.abs(z.player.car.st.d) < z.track.halfW[z.track.indexAt(z.player.car.st.s)], 'automatische Rücksetzung auf die Strecke');
}

// ------------------------------------------------------------------ Nässe & Schwierigkeit
console.log('\n▶ Nässe & Schwierigkeitsgrade');
{
  const times: Record<string, number> = {};
  for (const diff of ['beginner', 'normal', 'expert'] as const) {
    const s = new RaceSession({ ...base, difficulty: diff, aiCount: 1 }, 'race');
    times[diff] = s.cars.find((c) => !c.isPlayer)!.ai!.profile.lapTime;
  }
  console.log(`    KI-Sollrundenzeit Zandvoort: Anfänger ${times.beginner.toFixed(2)} s · Normal ${times.normal.toFixed(2)} s · Experte ${times.expert.toFixed(2)} s`);
  check(times.beginner > times.normal && times.normal > times.expert, 'Schwierigkeitsgrad beeinflusst das KI-Tempo');
  const dry = new RaceSession({ ...base, aiCount: 1 }, 'race');
  const wet = new RaceSession({ ...base, aiCount: 1, weather: 'wet' }, 'race');
  const tDry = dry.cars.find((c) => !c.isPlayer)!.ai!.profile.lapTime;
  const tWet = wet.cars.find((c) => !c.isPlayer)!.ai!.profile.lapTime;
  check(tWet > tDry * 1.08, `Nässe macht langsamer (${tDry.toFixed(1)} s → ${tWet.toFixed(1)} s)`);
  check(wet.cars.filter((c) => !c.isPlayer).every((c) => c.car.st.compound === 'inter'), 'KI startet bei Nässe auf Intermediates');
  // Stabilitätsassistent je Schwierigkeit
  const b = new RaceSession({ ...base, difficulty: 'beginner', aiCount: 0 }, 'practice');
  const e = new RaceSession({ ...base, difficulty: 'expert', aiCount: 0 }, 'practice');
  check(b.player.car.assists.stability > 0.5 && e.player.car.assists.stability === 0, 'Anfänger mit Stabilitätsassistent, Experte ohne');
}

// ------------------------------------------------------------------ Delta & Geisterauto
console.log('\n▶ Delta-Zeit & Geisterauto');
{
  const tr = new LapTrace();
  // Referenzrunde: konstant 50 m/s auf einer Geraden
  for (let s = 0; s <= 1000; s += 10) tr.add(s, s / 50, s, 0, 0, 0.1);
  check(Math.abs((tr.timeAt(505) ?? -1) - 10.1) < 1e-6, 'Referenzzeit an beliebiger Position interpoliert');
  const pose = [0, 0, 0, 0];
  check(tr.poseAt(4.0, pose) && Math.abs(pose[0] - 200) < 1e-6, 'Geisterauto-Position zum Zeitpunkt t');
  const restored = LapTrace.from(tr.serialize());
  check(restored.s.length === tr.s.length && Math.abs((restored.timeAt(777) ?? 0) - (tr.timeAt(777) ?? 1)) < 1e-3, 'Geisterdaten speichern/laden (localStorage-Format)');
  // eigene Runde 2 % langsamer -> Delta positiv
  const myT = 505 / 49;
  check(myT - (tr.timeAt(505) ?? 0) > 0.15, 'Delta positiv, wenn langsamer als die Bestzeit');
  check(tr.timeAt(-5) === null && tr.timeAt(2000) === null, 'kein Delta außerhalb der aufgezeichneten Runde');
}

console.log(`\n${passes} bestanden, ${failures} fehlgeschlagen`);
process.exit(failures ? 1 : 0);
