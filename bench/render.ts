/**
 * Offline gates, run in Node against the same Transport the worklet uses:
 *   node bench/render.ts [--input build/sample.wav] [--speed 0.75]
 * Writes renders under bench/out/ and prints the measurements.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BungeeStretcher } from '../src/stretcher.ts';
import { Transport } from '../src/transport.ts';
import { instantiateBungee, type BungeeExports } from '../src/wasm.ts';
import { readWav, writeWav } from './wav.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1] ?? '');
const inputPath = resolve(root, args.get('--input') ?? 'build/sample.wav');
const speed = Number(args.get('--speed') ?? '0.75');
const outDir = resolve(root, 'bench/out');
mkdirSync(outDir, { recursive: true });

const QUANTUM = 128;

interface Timing {
  count: number;
  mean: number;
  p50: number;
  p99: number;
  max: number;
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return { count: sorted.length, mean, p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
}

function db(value: number): string {
  return value <= 0 ? '-inf' : `${(20 * Math.log10(value)).toFixed(1)} dB`;
}

function rms(values: Float32Array | number[], from = 0, to = values.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += (values[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

async function loadModule(path: string): Promise<BungeeExports> {
  const module = await WebAssembly.compile(readFileSync(path));
  return instantiateBungee(module, (line) => console.log(`  [bungee] ${line}`));
}

const input = readWav(inputPath);
const frameCount = input.channels[0]!.length;
const sampleRate = input.sampleRate;
const source = { left: input.channels[0]!, right: input.channels[1] ?? input.channels[0]! };
console.log(`input: ${inputPath} ${sampleRate} Hz, ${frameCount} frames (${(frameCount / sampleRate).toFixed(2)} s)`);

interface Render {
  left: Float32Array;
  right: Float32Array;
  positions: Float64Array;
  frames: number;
  renderTimes: number[];
  transport: Transport;
}

/** Plays the transport in 128-frame quanta until it ends or `maxFrames` is reached, timing each render. */
function play(transport: Transport, maxFrames: number, onQuantum?: (frame: number) => void): Render {
  const left = new Float32Array(maxFrames);
  const right = new Float32Array(maxFrames);
  const positions = new Float64Array(maxFrames);
  const quantumLeft = new Float32Array(QUANTUM);
  const quantumRight = new Float32Array(QUANTUM);
  const renderTimes: number[] = [];
  let frames = 0;
  transport.play();
  while (transport.playing && frames + QUANTUM <= maxFrames) {
    onQuantum?.(frames);
    const started = performance.now();
    transport.render(quantumLeft, quantumRight, QUANTUM, positions.subarray(frames, frames + QUANTUM));
    renderTimes.push(performance.now() - started);
    left.set(quantumLeft, frames);
    right.set(quantumRight, frames);
    frames += QUANTUM;
  }
  return { left: left.subarray(0, frames), right: right.subarray(0, frames), positions: positions.subarray(0, frames), frames, renderTimes, transport };
}

function makeTransport(wasm: BungeeExports, playbackSpeed = speed): Transport {
  const stretcher = new BungeeStretcher(wasm, { sampleRate, channels: 2 });
  const transport = new Transport(stretcher, frameCount);
  transport.setSource('mix', source);
  transport.speed = playbackSpeed;
  return transport;
}

/** Max absolute difference between two renders over [from, to). */
function maxDiff(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let max = 0;
  for (let i = from; i < to; i += 1) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

const budgetMs = (QUANTUM / sampleRate) * 1000;
const variants = [
  { name: 'simd', path: resolve(root, 'dist/bungee.wasm') },
  { name: 'scalar', path: resolve(root, 'build/scalar/bungee.wasm') },
].filter((variant) => existsSync(variant.path));

const results: Record<string, unknown> = {};
let referenceRender: Render | null = null;

for (const variant of variants) {
  console.log(`\n== ${variant.name}: ${variant.path}`);
  const wasm = await loadModule(variant.path);
  console.log(`  Bungee ${BungeeStretcher.version(wasm)}, module ${readFileSync(variant.path).length} bytes`);

  // 1. Straight render at the requested speed, timed per 128-frame quantum.
  const transport = makeTransport(wasm);
  // Warm up the JIT on a few grains so the timing reflects steady state.
  transport.seek(0);
  for (let i = 0; i < 8; i += 1) transport.produceGrain();
  transport.seek(0);
  const render = play(transport, Math.ceil((frameCount / speed) * 1.05) + 8192);
  const timing = summarize(render.renderTimes);
  const grainTimes: number[] = [];
  {
    const t = makeTransport(wasm);
    t.seek(0);
    for (let i = 0; i < 400; i += 1) {
      const started = performance.now();
      t.produceGrain();
      grainTimes.push(performance.now() - started);
    }
  }
  const grainTiming = summarize(grainTimes);
  console.log(`  render x${speed}: ${render.frames} frames out (expected ~${Math.round(frameCount / speed)}), ended=${transport.ended}, stats=${JSON.stringify(transport.stats)}`);
  console.log(`  per-quantum render ms: mean ${timing.mean.toFixed(3)} p50 ${timing.p50.toFixed(3)} p99 ${timing.p99.toFixed(3)} max ${timing.max.toFixed(3)} (budget ${budgetMs.toFixed(2)} ms; max uses ${((timing.max / budgetMs) * 100).toFixed(0)}%)`);
  console.log(`  per-grain ms: mean ${grainTiming.mean.toFixed(3)} p99 ${grainTiming.p99.toFixed(3)} max ${grainTiming.max.toFixed(3)} (${transport.stats.grains} grains; one grain per ${(512 / QUANTUM).toFixed(0)} quanta)`);
  writeWav(resolve(outDir, `${variant.name}-x${speed}.wav`), { sampleRate, channels: [render.left, render.right] });
  results[variant.name] = { timing, grainTiming, frames: render.frames, stats: transport.stats };

  if (referenceRender) {
    const frames = Math.min(referenceRender.frames, render.frames);
    console.log(`  vs ${variants[0]!.name}: max |diff| ${maxDiff(referenceRender.left, render.left, 0, frames).toExponential(2)}`);
  } else {
    referenceRender = render;
  }

  if (variant !== variants[0]) continue;

  // 2. Passthrough at 1.0: output frame i should equal the source at its reported position.
  {
    const t = makeTransport(wasm, 1);
    const r = play(t, frameCount + 8192);
    let worst = 0;
    let worstAt = 0;
    const from = 4096;
    for (let i = from; i < r.frames - 4096; i += 1) {
      const p = Math.round(r.positions[i] ?? 0);
      if (p < 0 || p >= frameCount) continue;
      const d = Math.abs((r.left[i] ?? 0) - (source.left[p] ?? 0));
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    console.log(`  x1.0 passthrough: max |out - src[pos]| ${worst.toExponential(2)} at frame ${worstAt} (${db(worst)}), first position ${r.positions[0]?.toFixed(1)}, frames ${r.frames} vs source ${frameCount}`);
    results.passthrough = { worst, worstAt, frames: r.frames };
    writeWav(resolve(outDir, 'passthrough-x1.wav'), { sampleRate, channels: [r.left, r.right] });
  }

  // 3. Seek: start at S mid-track and compare with the straight render's frames from the same position.
  {
    const target = Math.floor(frameCount * 0.4);
    const t = makeTransport(wasm);
    t.seek(target);
    const r = play(t, 2 * sampleRate);
    const startPosition = r.positions[0] ?? NaN;
    // Frames in the straight render at or past `target`.
    let refIndex = 0;
    while (refIndex < render.frames && (render.positions[refIndex] ?? 0) < target) refIndex += 1;
    const window = 512;
    const bands: string[] = [];
    for (let b = 0; b < 8; b += 1) {
      const a = b * window;
      const seekRms = rms(r.left, a, a + window);
      const refRms = rms(render.left, refIndex + a, refIndex + a + window);
      bands.push(`${(20 * Math.log10(seekRms / Math.max(1e-9, refRms))).toFixed(1)}`);
    }
    console.log(`  seek to ${target}: first output position ${startPosition.toFixed(1)} (error ${(startPosition - target).toFixed(1)} frames), trimmed ${t.stats.trimmedFrames}; level vs straight render per 512-frame band (dB): ${bands.join(' ')}`);
    results.seek = { target, startPosition, bands };
  }

  // 4. Loop: positions must wrap at the end and never leave the range once inside.
  {
    const loop = { start: Math.floor(sampleRate * 3), end: Math.floor(sampleRate * 5) };
    const t = makeTransport(wasm);
    t.seek(Math.floor(sampleRate * 2.5));
    t.setLoop(loop);
    const r = play(t, 8 * sampleRate);
    let wraps = 0;
    let outside = 0;
    let entered = false;
    let maxJump = 0;
    for (let i = 1; i < r.frames; i += 1) {
      const previous = r.positions[i - 1] ?? 0;
      const current = r.positions[i] ?? 0;
      if (current >= loop.start) entered = true;
      if (entered && (current < loop.start || current >= loop.end)) outside += 1;
      if (current < previous - 1) wraps += 1;
      const jump = Math.abs((r.left[i] ?? 0) - (r.left[i - 1] ?? 0));
      if (jump > maxJump) maxJump = jump;
    }
    console.log(`  loop [${loop.start}, ${loop.end}) from 2.5 s: wraps ${wraps} (expected ${Math.floor((8 * speed - 0.5) / 2)}), frames outside once inside ${outside}, ended=${t.ended}, max sample step ${maxJump.toFixed(3)}, underruns ${t.stats.underruns}`);
    results.loop = { wraps, outside };
    writeWav(resolve(outDir, 'loop.wav'), { sampleRate, channels: [r.left, r.right] });
  }

  // 5. Speed changes every 0.5 s between 1.0 and other speeds; position must follow speed.
  {
    const t = makeTransport(wasm, 1);
    t.seek(0);
    const schedule = [1, speed, 0.9, speed, 1.25, speed, 1];
    let step = 0;
    const r = play(t, 6 * sampleRate, (frame) => {
      const slot = Math.floor(frame / (sampleRate * 0.5));
      if (slot !== step) {
        step = slot;
        t.speed = schedule[slot % schedule.length]!;
      }
    });
    // Measured speed per 0.5 s window vs commanded, ignoring the 100 ms after each change.
    const report: string[] = [];
    for (let slot = 0; slot < schedule.length && (slot + 1) * sampleRate * 0.5 <= r.frames; slot += 1) {
      const from = Math.floor(slot * sampleRate * 0.5 + sampleRate * 0.1);
      const to = Math.floor((slot + 1) * sampleRate * 0.5) - 1;
      const measured = ((r.positions[to] ?? 0) - (r.positions[from] ?? 0)) / (to - from);
      report.push(`${schedule[slot]}->${measured.toFixed(3)}`);
    }
    console.log(`  speed ramp (commanded->measured): ${report.join(' ')}; underruns ${t.stats.underruns}`);
    results.ramp = report;
    writeWav(resolve(outDir, 'ramp.wav'), { sampleRate, channels: [r.left, r.right] });
  }

  // 6. Loop edits while playing: an end dragged to just ahead of the playhead must wrap, not cut.
  {
    const t = makeTransport(wasm, 1);
    t.seek(0);
    let loopEnd = 0;
    const r = play(t, 3 * sampleRate, (frame) => {
      if (loopEnd === 0 && frame >= 1 * sampleRate) {
        loopEnd = Math.round(t.position) + 300;
        t.setLoop({ start: 1000, end: loopEnd });
      }
      if (t.loop && frame >= 2 * sampleRate) t.setLoop(null);
    });
    let backwards = 0;
    let wrapAt = -1;
    let lateBy = 0;
    for (let i = 1; i < r.frames; i += 1) {
      const previous = r.positions[i - 1] ?? 0;
      const current = r.positions[i] ?? 0;
      if (current < previous - 1) {
        backwards += 1;
        if (wrapAt < 0) {
          wrapAt = i;
          lateBy = previous - (t.loop?.end ?? previous);
        }
      }
    }
    console.log(`  loop edit while playing: end set ${300} frames ahead of the playhead; backwards jumps ${backwards} (wraps only), first wrap at output frame ${wrapAt}, played ${Math.max(0, Math.round((r.positions[wrapAt - 1] ?? 0) - loopEnd))} frames past the new end before wrapping, trimmed ${t.stats.trimmedFrames}, underruns ${t.stats.underruns}`);
    results.loopEdit = { backwards, wrapAt, lateBy };
    writeWav(resolve(outDir, 'loop-edit.wav'), { sampleRate, channels: [r.left, r.right] });
  }

  // 7. A six-source mix with live channel changes: cost per grain and per quantum with a real stem count.
  {
    const t = makeTransport(wasm);
    const ids = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
    ids.forEach((id, i) => t.setSource(id, source, { gain: 1 / ids.length, pan: (i - 2.5) / 2.5 }));
    t.removeSource('mix');
    t.seek(0);
    let step = 0;
    const r = play(t, Math.ceil((frameCount / speed) * 1.05) + 8192, (frame) => {
      const slot = Math.floor(frame / (sampleRate * 0.5));
      if (slot !== step) {
        step = slot;
        ids.forEach((id, i) => t.setChannel(id, { gain: (slot + i) % 3 === 0 ? 0 : 0.25, pan: Math.sin(slot + i) }));
      }
    });
    const mixTiming = summarize(r.renderTimes);
    let peak = 0;
    let bad = 0;
    for (let i = 0; i < r.frames; i += 1) {
      const value = r.left[i] ?? 0;
      if (!Number.isFinite(value)) bad += 1;
      peak = Math.max(peak, Math.abs(value));
    }
    console.log(`  six-source mix x${speed} with channel changes every 0.5 s: per-quantum ms mean ${mixTiming.mean.toFixed(3)} p99 ${mixTiming.p99.toFixed(3)} max ${mixTiming.max.toFixed(3)} (max uses ${((mixTiming.max / budgetMs) * 100).toFixed(0)}% of ${budgetMs.toFixed(2)} ms), peak ${peak.toFixed(2)}, non-finite ${bad}, underruns ${t.stats.underruns}`);
    results.stemMix = { timing: mixTiming, peak, bad };
  }

  // 8. Native reference render, if the CLI was built.
  const cli = [resolve(root, 'build/deps/bungee-build/bungee'), resolve(root, 'build/native/_deps/bungee-build/bungee')].find((p) => existsSync(p));
  if (cli) {
    const referencePath = resolve(outDir, `native-x${speed}.wav`);
    execFileSync(cli, ['--speed', String(speed), inputPath, referencePath], { stdio: 'pipe' });
    const reference = readWav(referencePath);
    const refLeft = reference.channels[0]!;
    const frames = Math.min(refLeft.length, render.frames);
    let best = { lag: 0, diff: Infinity };
    for (let lag = -4; lag <= 4; lag += 1) {
      let max = 0;
      for (let i = 4096; i < frames - 4096; i += 1) max = Math.max(max, Math.abs((render.left[i] ?? 0) - (refLeft[i + lag] ?? 0)));
      if (max < best.diff) best = { lag, diff: max };
    }
    console.log(`  vs native CLI (${cli}): ${refLeft.length} frames, ours ${render.frames}; best lag ${best.lag}, max |diff| ${best.diff.toExponential(2)} (${db(best.diff)}), output RMS ours ${db(rms(render.left))} native ${db(rms(refLeft))}`);
    results.native = best;
  } else {
    console.log('  native CLI not built (scripts/build-native.sh); skipping reference comparison');
  }
}

console.log('\nsummary: ' + JSON.stringify(results));
