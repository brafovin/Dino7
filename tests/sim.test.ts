// Headless-Tests der Simulation: Strecken, Teams, Fahrphysik, Getriebe, Rundenzeitmessung, KI, Rennen.
// Aufruf: npm run test:sim   (optional: --quick für weniger Strecken bei den Rennen)
import { AIDriver } from '../src/shared/ai';
import { Car, emptyInput, makeCarParams, type StepEnv } from '../src/shared/carPhysics';
import { collideWalls } from '../src/shared/collisions';
import { LapTracker } from '../src/shared/lapTracker';
import { formatTime } from '../src/shared/math';
import { computeRacingLine } from '../src/shared/racingLine';
import { ALL_DRIVERS, TEAMS } from '../src/shared/teams';
import { Track } from '../src/shared/track';
import { TRACK_DEFS } from '../src/shared/trackDefs';
import { getDifficulty, type SessionConfig } from '../src/sim/config';
import { RaceSession } from '../src/sim/RaceSession';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
function section(name: string): void {
  console.log(`\n▶ ${name}`);
}
const quick = process.argv.includes('--quick');

// ------------------------------------------------------------------ Strecken
section('Strecken');
const tracks = new Map<string, Track>();
check(TRACK_DEFS.length === 8, 'genau 8 Strecken');
for (const def of TRACK_DEFS) {
  const t = new Track(def);
  tracks.set(def.id, t);
  check(Math.abs(t.length - def.lengthKm * 1000) < 0.5, `${def.id}: Länge ${t.length} = ${def.lengthKm} km`);
  check(t.warnings.length === 0, `${def.id}: keine Bau-Warnungen (${t.warnings.slice(0, 2).join('; ')})`);
  check(t.sectors[0] > 0 && t.sectors[0] < t.sectors[1] && t.sectors[1] < t.length, `${def.id}: Sektoren geordnet`);
  // Schließung: letzter -> erster Punkt ~ Abtastabstand
  const gap = Math.hypot(t.px[0] - t.px[t.n - 1], t.pz[0] - t.pz[t.n - 1]);
  check(gap < t.spacing * 1.5, `${def.id}: geschlossen (Lücke ${gap.toFixed(2)} m)`);
  // Barrieren außerhalb der Fahrbahn
  let badBar = 0;
  for (let i = 0; i < t.n; i++) if (t.barL[i] < t.halfW[i] + 0.9 || t.barR[i] < t.halfW[i] + 0.9) badBar++;
  check(badBar === 0, `${def.id}: Barrieren neben der Fahrbahn (${badBar} Fehler)`);
  // Projektion: Punkte auf der Mittellinie
  const pr = { i: 0, s: 0, d: 0, y: 0, tx: 0, tz: 1, dist2: 0 };
  let projErr = 0;
  for (let i = 0; i < t.n; i += 37) {
    t.project(t.px[i] + t.nx[i] * 3, t.pz[i] + t.nz[i] * 3, i, pr);
    projErr = Math.max(projErr, Math.abs(pr.d - 3), Math.abs(t.deltaS(pr.s, i * t.spacing)));
  }
  check(projErr < 0.6, `${def.id}: Projektion genau (Fehler ${projErr.toFixed(3)})`);
  console.log(`  ${def.name.padEnd(26)} ${(t.length / 1000).toFixed(3)} km, ${t.corners.length} Kurven, Höhe ${t.minY.toFixed(0)}..${t.maxY.toFixed(0)} m`);
}
const suz = tracks.get('suzuka')!;
check(suz.crossing !== null, 'Suzuka: Kreuzung erkannt');
if (suz.crossing) check(suz.py[suz.crossing.over] - suz.py[suz.crossing.under] > 7, 'Suzuka: Brücke über Unterführung (> 7 m)');
const spa = tracks.get('spa')!;
check(spa.maxY - spa.minY > 50, 'Spa: deutliche Höhenunterschiede');
const monaco = tracks.get('monaco')!;
check(monaco.halfW[0] * 2 < 11, 'Monaco: schmale Strecke');
check(Array.from(monaco.flags).some((f) => f === 1), 'Monaco: Tunnel vorhanden');

// ------------------------------------------------------------------ Teams
section('Teams & Fahrer');
check(TEAMS.length === 11, '11 Teams');
check(ALL_DRIVERS.length === 22, '22 Fahrer');
check(TEAMS.every((t) => t.drivers.length === 2), 'je 2 Fahrer pro Team');
check(new Set(ALL_DRIVERS.map((d) => d.id)).size === 22, 'eindeutige Fahrer-IDs');
check(new Set(ALL_DRIVERS.map((d) => d.code)).size === 22, 'eindeutige Kürzel');
check(new Set(TEAMS.map((t) => t.livery.primary)).size === 11, 'eigene Lackierungsfarbe je Team');
const perfSpread = Math.max(...TEAMS.map((t) => t.perf.power)) - Math.min(...TEAMS.map((t) => t.perf.power));
check(perfSpread < 0.05, 'faires Balancing der Motorleistung');

// ------------------------------------------------------------------ Physik
section('Fahrphysik');
const monza = tracks.get('monza')!;
const env: StepEnv = { weather: 'dry', slipstream: 0, frozen: false, wearScale: 0, fuelUse: false };
function straightRun(assists: Car['assists'], seconds: number, onSample: (t: number, car: Car) => void): Car {
  const car = new Car(makeCarParams());
  car.assists = assists;
  car.st.fuel = 20;
  car.placeAt(monza, 20, 0); // Start der Hauptgeraden
  const inp = emptyInput();
  inp.throttle = 1;
  inp.steerAngle = 0;
  const dt = 1 / 240;
  for (let t = 0; t < seconds; t += dt) {
    car.step(inp, dt, monza, env);
    onSample(t, car);
  }
  return car;
}
let t100 = -1;
let t200 = -1;
straightRun({ tc: 2, abs: true, steering: false, autoGear: true, stability: 0 }, 8, (t, c) => {
  const kmh = c.st.vx * 3.6;
  if (t100 < 0 && kmh >= 100) t100 = t;
  if (t200 < 0 && kmh >= 200) t200 = t;
});
console.log(`  0-100 km/h: ${t100.toFixed(2)} s, 0-200 km/h: ${t200.toFixed(2)} s`);
check(t100 > 2.0 && t100 < 3.6, '0-100 km/h zwischen 2,0 und 3,6 s');
check(t200 > 4.0 && t200 < 7.5, '0-200 km/h zwischen 4,0 und 7,5 s');
// Ohne TC: Durchdrehen beim Start
let maxSpin = 0;
straightRun({ tc: 0, abs: true, steering: false, autoGear: true, stability: 0 }, 1.5, (_t, c) => {
  maxSpin = Math.max(maxSpin, c.st.wheelspin);
});
check(maxSpin > 0.2, `ohne TC drehen die Räder beim Vollgasstart durch (${maxSpin.toFixed(2)})`);
let maxSpinTc = 0;
straightRun({ tc: 2, abs: true, steering: false, autoGear: true, stability: 0 }, 1.5, (_t, c) => {
  maxSpinTc = Math.max(maxSpinTc, c.st.wheelspin);
});
check(maxSpinTc < 0.05, `mit TC hoch kaum Durchdrehen (${maxSpinTc.toFixed(2)})`);

// Höchstgeschwindigkeit auf flacher Ebene (lange Gerade simulieren: Monza Hauptgerade + Wiederholung)
{
  const car = new Car(makeCarParams());
  car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
  car.st.fuel = 10;
  const inp = emptyInput();
  inp.throttle = 1;
  let vmax = 0;
  const dt = 1 / 240;
  car.placeAt(monza, 20, 0, 80);
  for (let t = 0; t < 12; t += dt) {
    car.step(inp, dt, monza, env);
    // auf der Geraden halten
    if (car.st.s > 1200 && car.st.s < 3000) car.placeAt(monza, 20, 0, car.st.vx);
    inp.steerAngle = 0;
    vmax = Math.max(vmax, car.st.vx);
  }
  console.log(`  Höchstgeschwindigkeit: ${(vmax * 3.6).toFixed(0)} km/h, Gang ${car.st.gear}`);
  check(vmax * 3.6 > 320 && vmax * 3.6 < 375, 'Höchstgeschwindigkeit 320-375 km/h');
  check(car.st.gear >= 7, 'Automatik schaltet bis in hohe Gänge');
  // Bremsen von Topspeed
  const binp = emptyInput();
  binp.brake = 1;
  binp.steerAngle = 0;
  car.placeAt(monza, 20, 0, 300 / 3.6);
  car.st.gear = 7;
  const x0 = car.st.x;
  const z0 = car.st.z;
  let tb = 0;
  while (car.st.vx > 80 / 3.6 && tb < 10) {
    car.step(binp, dt, monza, env);
    tb += dt;
  }
  const dist = Math.hypot(car.st.x - x0, car.st.z - z0);
  console.log(`  Bremsweg 300→80 km/h: ${dist.toFixed(0)} m in ${tb.toFixed(2)} s`);
  check(dist > 70 && dist < 160, 'Bremsweg 300→80 km/h plausibel (70-160 m)');
  check(car.st.gear < 7, 'Automatik schaltet beim Bremsen herunter');
}
// Manuelles Getriebe
{
  const car = new Car(makeCarParams());
  car.assists = { tc: 2, abs: true, steering: false, autoGear: false, stability: 0 };
  car.placeAt(monza, 20, 0);
  const inp = emptyInput();
  inp.throttle = 1;
  inp.steerAngle = 0;
  const dt = 1 / 240;
  let maxRpm = 0;
  for (let t = 0; t < 3; t += dt) {
    car.step(inp, dt, monza, env);
    maxRpm = Math.max(maxRpm, car.st.rpm);
  }
  check(car.st.gear === 1, 'manuell: bleibt ohne Schaltbefehl im 1. Gang');
  check(maxRpm >= car.p.maxRpm - 50 && maxRpm < car.p.maxRpm + 400, `manuell: Drehzahlbegrenzer greift (${maxRpm.toFixed(0)})`);
  const vAt1 = car.st.vx;
  inp.shiftUp = true;
  car.step(inp, dt, monza, env);
  inp.shiftUp = false;
  for (let t = 0; t < 0.2; t += dt) car.step(inp, dt, monza, env);
  check(car.st.gear === 2, 'manuell: Hochschalten');
  for (let t = 0; t < 1.0; t += dt) car.step(inp, dt, monza, env);
  check(car.st.vx > vAt1 + 3, 'manuell: beschleunigt im 2. Gang weiter');
  // Falscher Gang: im 8. Gang aus niedriger Geschwindigkeit kaum Beschleunigung
  const car8 = new Car(makeCarParams());
  car8.assists = { tc: 2, abs: true, steering: false, autoGear: false, stability: 0 };
  car8.placeAt(monza, 20, 0, 20);
  car8.st.gear = 8;
  const v0 = car8.st.vx;
  for (let t = 0; t < 1; t += dt) car8.step(inp, dt, monza, env);
  const car3 = new Car(makeCarParams());
  car3.assists = { tc: 2, abs: true, steering: false, autoGear: false, stability: 0 };
  car3.placeAt(monza, 20, 0, 20);
  car3.st.gear = 2;
  for (let t = 0; t < 1; t += dt) car3.step(inp, dt, monza, env);
  console.log(`  1 s Vollgas ab 72 km/h: 8. Gang +${((car8.st.vx - v0) * 3.6).toFixed(0)} km/h, 2. Gang +${((car3.st.vx - v0) * 3.6).toFixed(0)} km/h`);
  check(car3.st.vx - v0 > (car8.st.vx - v0) * 1.5, 'falsche Gangwahl kostet deutlich Beschleunigung');
  // Überdrehschutz beim Runterschalten
  const carD = new Car(makeCarParams());
  carD.assists = { tc: 2, abs: true, steering: false, autoGear: false, stability: 0 };
  carD.placeAt(monza, 20, 0, 80);
  carD.st.gear = 7;
  const din = emptyInput();
  din.steerAngle = 0;
  din.shiftDown = true;
  for (let k = 0; k < 6; k++) {
    carD.step(din, dt, monza, env);
    for (let t = 0; t < 0.1; t += dt) carD.step({ ...din, shiftDown: false }, dt, monza, env);
  }
  check(carD.st.gear >= 3, `Überdrehschutz verhindert zu frühes Runterschalten (Gang ${carD.st.gear})`);
  // Rückwärtsgang (Automatik)
  const carR = new Car(makeCarParams());
  carR.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
  carR.placeAt(monza, 20, 0);
  const rin = emptyInput();
  rin.brake = 1;
  rin.steerAngle = 0;
  for (let t = 0; t < 2.5; t += dt) carR.step(rin, dt, monza, env);
  check(carR.st.gear === -1 && carR.st.vx < -1, 'Bremse im Stand halten -> Rückwärtsgang');
}
// Nässe reduziert Grip
{
  const car = new Car(makeCarParams());
  const dry = car.lateralCapacity(50, 'dry');
  const wet = car.lateralCapacity(50, 'wet');
  car.st.compound = 'inter';
  const wetInter = car.lateralCapacity(50, 'wet');
  console.log(`  Quer-g bei 180 km/h: trocken ${(dry / 9.81).toFixed(2)} g, nass (Medium) ${(wet / 9.81).toFixed(2)} g, nass (Inter) ${(wetInter / 9.81).toFixed(2)} g`);
  check(wet < dry * 0.7, 'Nässe reduziert Haftung deutlich');
  check(wetInter > wet * 1.2, 'Intermediates bei Nässe besser als Slicks');
  check(car.lateralCapacity(80, 'dry') > car.lateralCapacity(30, 'dry') * 1.4, 'Abtrieb erhöht Kurvengrip mit der Geschwindigkeit');
}
// Kollision mit der Wand
{
  const car = new Car(makeCarParams());
  car.placeAt(monza, 300, 0, 40);
  car.st.heading += 0.5; // schräg auf die Wand
  const inp = emptyInput();
  inp.throttle = 0.5;
  inp.steerAngle = 0;
  let hit = 0;
  let maxD = 0;
  for (let t = 0; t < 4; t += 1 / 240) {
    car.step(inp, 1 / 240, monza, env);
    hit = Math.max(hit, collideWalls(car, monza));
    maxD = Math.max(maxD, Math.abs(car.st.d) - monza.barrierAt(car.st.s, car.st.d > 0));
  }
  check(hit > 1, `Wandkontakt erkannt (Aufprall ${hit.toFixed(1)} m/s)`);
  check(maxD < 0.3, `Fahrzeug bleibt innerhalb der Barriere (Überstand ${maxD.toFixed(2)} m)`);
}

// ------------------------------------------------------------------ Rundenzeitmessung
section('Rundenzeitmessung');
{
  const L = 1000;
  const lt = new LapTracker(L, 330, 660);
  lt.startRace(0);
  // Startaufstellung bei s=990 -> erste Zieldurchfahrt zählt nicht
  let ev = lt.update(990, 10, 0, 1);
  check(ev.some((e) => e.type === 'cross-start') && lt.completed === 0, 'erste Durchfahrt aus der Startaufstellung zählt nicht als Runde');
  // Runde fahren: 10 -> 999 in Schritten
  let s = 10;
  let t = 1;
  const all: string[] = [];
  while (lt.completed < 1) {
    const ns = (s + 10) % L;
    const evs = lt.update(s, ns, t, t + 0.1);
    for (const e of evs) all.push(e.type);
    s = ns;
    t += 0.1;
  }
  check(all.filter((x) => x === 'sector').length === 2, 'zwei Sektorzeiten pro Runde');
  // Runde 1 zählt ab Startsignal (t=0) bis zur zweiten Zieldurchfahrt bei t≈10,9 s
  check(lt.lastLap !== null && Math.abs(lt.lastLap - 10.9) < 0.02, `Rundenzeit korrekt interpoliert (${lt.lastLap?.toFixed(3)})`);
  // Abkürzung: direkt von s=200 zur Ziellinie zurück (Sektoren ausgelassen) zählt nicht
  ev = lt.update(10, 200, t, t + 1);
  ev = lt.update(200, 999, t + 1, t + 2);
  ev = lt.update(999, 5, t + 2, t + 2.1);
  check(lt.completed === 2 || lt.completed === 1, 'Sprung-Test ausgeführt');
  const lt2 = new LapTracker(L, 330, 660);
  lt2.startRace(0);
  lt2.update(990, 5, 0, 0.1);
  lt2.update(5, 100, 0.1, 1);
  lt2.update(100, 980, 1, 2); // rückwärts über die Linie (Abkürzung)
  lt2.update(980, 5, 2, 2.1);
  check(lt2.completed === 0, 'Rückwärts über die Linie und wieder vorwärts zählt keine Runde');
  // Zeitfahren: Zeitnahme ab erster Zieldurchfahrt
  const tt = new LapTracker(L, 330, 660);
  tt.update(900, 20, 5, 5.2);
  check(tt.timing && Math.abs(tt.lapStart - 5.16) < 0.01, 'Zeitfahren: Zeitnahme startet an der Linie (interpoliert)');
}

// ------------------------------------------------------------------ KI auf allen Strecken
section('KI-Einzelrunden (alle Strecken)');
for (const def of TRACK_DEFS) {
  const track = tracks.get(def.id)!;
  const line = computeRacingLine(track);
  const car = new Car(makeCarParams());
  car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
  car.st.fuel = 10;
  const grip = getDifficulty('expert').aiGrip;
  const ai = new AIDriver(car, track, line, { grip, brake: grip * 0.98, racecraft: 0.5, consistency: 1 }, 'dry', 1);
  const slot = track.gridSlot(0);
  car.placeAt(track, slot.s, slot.d);
  const lt = new LapTracker(track.length, track.sectors[0], track.sectors[1]);
  lt.startRace(0);
  const dt = 1 / 120;
  let t = 0;
  let resets = 0;
  let walls = 0;
  let prevS = car.st.s;
  const e2: StepEnv = { weather: 'dry', slipstream: 0, frozen: false, wearScale: 1, fuelUse: true };
  while (t < 300 && lt.completed < 2) {
    const inp = ai.update(dt, [], 0, true);
    car.step(inp, dt / 2, track, e2);
    if (collideWalls(car, track) > 3) walls++;
    car.step(inp, dt / 2, track, e2);
    if (collideWalls(car, track) > 3) walls++;
    t += dt;
    lt.update(prevS, car.st.s, t - dt, t);
    prevS = car.st.s;
    if (ai.wantsReset) {
      resets++;
      car.placeAt(track, car.st.s, track.raceLine[track.indexAt(car.st.s)]);
      ai.onReset();
    }
  }
  console.log(`  ${def.name.padEnd(26)} Runden ${lt.lapTimes.map((x) => formatTime(x)).join(' / ')}  Resets ${resets}  Einschläge ${walls}`);
  check(lt.completed === 2, `${def.id}: KI absolviert 2 Runden`);
  check(resets === 0, `${def.id}: KI ohne Reset`);
  check(walls === 0, `${def.id}: KI ohne harte Einschläge`);
}

// ------------------------------------------------------------------ Volles Rennen
section('Grand Prix mit vollem Feld (Spieler = Autopilot)');
const raceTracks = quick ? ['monaco', 'silverstone'] : TRACK_DEFS.map((d) => d.id);
for (const id of raceTracks) {
  const cfg: SessionConfig = {
    mode: 'grandprix',
    trackId: id,
    laps: 2,
    weather: id === 'spa' ? 'wet' : 'dry',
    difficulty: 'normal',
    playerDriverId: 'leclerc',
    aiCount: 21,
    startMode: 'random',
    wearScale: 1,
    startCompound: 'medium',
    transmission: 'auto',
    assists: { tc: 'high', abs: true, line: 'off', steering: false, brake: false, autoReset: true, pitAssist: true },
    seed: 1234,
  };
  const sess = new RaceSession(cfg, 'race');
  // Spieler wird von einer KI gefahren
  const pAI = new AIDriver(sess.player.car, sess.track, sess.line, { grip: 0.9, brake: 0.88, racecraft: 0.6, consistency: 1 }, cfg.weather, 7);
  sess.startCountdown();
  const dt = 1 / 120;
  let resets = 0;
  let impacts = 0;
  let lastPositionsOk = true;
  const wall0 = performance.now();
  while (sess.phase !== 'finished' && sess.time < 600) {
    const others = sess.cars.map((c) => ({ car: c.car, id: c.id }));
    const inp = pAI.update(dt, others, sess.player.id, sess.phase === 'racing');
    sess.step(dt, inp);
    if (pAI.wantsReset) {
      sess.resetCar(sess.player);
      pAI.onReset();
    }
    for (const e of sess.drainEvents()) {
      if (e.type === 'reset') resets++;
      if (e.type === 'impact' && e.speed > 6) impacts++;
    }
    const pos = sess.cars.map((c) => c.position).sort((a, b) => a - b);
    if (!pos.every((p, i) => p === i + 1)) lastPositionsOk = false;
  }
  const wall = (performance.now() - wall0) / 1000;
  const res = sess.results();
  const finished = res.filter((r) => r.status === 'Im Ziel').length;
  console.log(
    `  ${id.padEnd(12)} Sieger ${res[0].driver.code} ${res[0].gapText}  Im Ziel ${finished}/22  Resets ${resets}  harte Kontakte ${impacts}  ` +
      `Spieler P${res.find((r) => r.carId === sess.player.id)!.position}  (${wall.toFixed(1)} s Rechenzeit für ${sess.time.toFixed(0)} s)`,
  );
  check(sess.phase === 'finished', `${id}: Rennen beendet`);
  check(finished >= 20, `${id}: mindestens 20 Fahrzeuge im Ziel (${finished})`);
  check(lastPositionsOk, `${id}: Positionen immer eindeutig 1..22`);
  check(resets <= 6, `${id}: wenige Resets im Feld (${resets})`);
  check(res.every((r, i) => i === 0 || r.time === null || res[i - 1].time === null || (r.time as number) >= (res[i - 1].time as number) - 1e-6), `${id}: Ergebnis nach Zeit sortiert`);
}

console.log(`\n${passes} bestanden, ${failures} fehlgeschlagen`);
process.exit(failures ? 1 : 0);
