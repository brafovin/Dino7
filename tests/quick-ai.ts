// Schnelltest: eine KI fährt auf jeder Strecke zwei Runden.
import { AIDriver } from '../src/shared/ai';
import { Car, makeCarParams } from '../src/shared/carPhysics';
import { collideWalls } from '../src/shared/collisions';
import { LapTracker } from '../src/shared/lapTracker';
import { formatTime } from '../src/shared/math';
import { computeRacingLine } from '../src/shared/racingLine';
import { Track } from '../src/shared/track';
import { TRACK_DEFS } from '../src/shared/trackDefs';

const only = process.argv[2];
const grip = Number(process.argv[3] ?? 0.97);
for (const def of TRACK_DEFS) {
  if (only && def.id !== only) continue;
  const track = new Track(def);
  const line = computeRacingLine(track);
  const car = new Car(makeCarParams());
  car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
  car.st.fuel = 10;
  const ai = new AIDriver(car, track, line, { grip, brake: grip, racecraft: 0.5, consistency: 1 }, 'dry', 1);
  const slot = track.gridSlot(0);
  car.placeAt(track, slot.s, slot.d);
  const lt = new LapTracker(track.length, track.sectors[0], track.sectors[1]);
  lt.startRace(0);
  const dt = 1 / 120;
  let t = 0;
  let walls = 0, resets = 0, offs = 0, maxV = 0;
  let prevS = car.st.s;
  const env = { weather: 'dry' as const, slipstream: 0, frozen: false, wearScale: 1, fuelUse: true };
  let wasOff = false;
  while (t < 400 && lt.completed < 2) {
    const inp = ai.update(dt, [], 0, true);
    for (let k = 0; k < 2; k++) {
      car.step(inp, dt / 2, track, env);
      if (collideWalls(car, track) > 2) walls++;
    }
    t += dt;
    lt.update(prevS, car.st.s, t - dt, t);
    prevS = car.st.s;
    maxV = Math.max(maxV, car.st.vx);
    const off = car.st.offTrack > 0.7;
    if (off && !wasOff) offs++;
    wasOff = off;
    if (ai.wantsReset) {
      resets++;
      car.placeAt(track, car.st.s, track.raceLine[track.indexAt(car.st.s)]);
      ai.onReset();
    }
  }
  console.log(`${def.id.padEnd(12)} laps=${lt.completed} times=${lt.lapTimes.map((x) => formatTime(x)).join(', ')} est=${formatTime(ai.profile.lapTime)} vmax=${(maxV * 3.6).toFixed(0)} walls=${walls} offs=${offs} resets=${resets} wear=${car.st.tyreWear.map((w) => w.toFixed(3)).join('/')} fuel=${car.st.fuel.toFixed(2)}`);
}
