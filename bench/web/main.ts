import { BungeeNode } from '../../src/node.ts';
import type { PositionReport, WorkletStats } from '../../src/protocol.ts';
import { compileBungee } from '../../src/wasm.ts';
import wasmUrl from '../../dist/bungee.wasm?url';
import workletUrl from '../../dist/worklet.js?url';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
const log = (line: string) => {
  status.textContent = line;
  console.log(line);
};

interface Capacity {
  averageLoad: number;
  peakLoad: number;
  underrunRatio: number;
  updates: number;
}

interface Bench {
  /** `sources` copies the sample that many times with spread pans (default from ?sources=, else 1). */
  init(options?: { silent?: boolean; sources?: number }): Promise<{ version: string; hop: number; sampleRate: number; frames: number; sources: number }>;
  channel(id: string, gain: number, pan: number): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  speed(value: number): void;
  loop(a: number | null, b?: number): void;
  stats(): Promise<WorkletStats & { extrapolated: number; contextTime: number; outputLatency: number; baseLatency: number; capacity: Capacity | null }>;
  close(): void;
  reports(): PositionReport[];
  clearReports(): void;
  ended: number;
}

let context: AudioContext | null = null;
let node: BungeeNode | null = null;
let gain: GainNode | null = null;
let frames = 0;
let sampleRate = 44100;
let capacity: Capacity | null = null;
const reports: PositionReport[] = [];
const sourceIds: string[] = [];

const bench: Bench = {
  ended: 0,
  async init(options = {}) {
    if (node) throw new Error('already initialised');
    context = new AudioContext();
    sampleRate = context.sampleRate;
    log(`AudioContext at ${sampleRate} Hz; loading worklet and wasm`);
    const [module] = await Promise.all([compileBungee(fetch(wasmUrl)), BungeeNode.addModule(context, workletUrl)]);
    node = new BungeeNode(context, module);
    node.on('log', (line) => console.log('[bungee]', line));
    node.on('error', (message) => log(`worklet error: ${message}`));
    node.on('position', (report) => reports.push(report));
    node.on('ended', () => {
      bench.ended += 1;
      log('ended');
    });
    const ready = await node.ready;
    log(`Bungee ${ready.version}, hop ${ready.hop}; decoding /sample.wav`);
    const response = await fetch('/sample.wav');
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    frames = decoded.length;
    const left = decoded.getChannelData(0);
    const right = decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1));
    const count = Math.max(1, options.sources ?? Number(new URLSearchParams(location.search).get('sources') ?? '1'));
    sourceIds.length = 0;
    const sources = Array.from({ length: count }, (_, i) => {
      const id = count === 1 ? 'mix' : `stem-${i}`;
      sourceIds.push(id);
      // Copies, so the decoded buffer stays usable; gains sum to about unity.
      return { id, left: left.slice(), right: right.slice(), gain: 1 / count, pan: count === 1 ? 0 : (i / (count - 1)) * 2 - 1 };
    });
    node.load(frames, sources);
    // Chrome's render-thread load meter, when present: the honest measure of worklet cost.
    const meter = (context as AudioContext & { renderCapacity?: EventTarget & { start(options?: { updateInterval?: number }): void } }).renderCapacity;
    if (meter) {
      capacity = { averageLoad: 0, peakLoad: 0, underrunRatio: 0, updates: 0 };
      meter.addEventListener('update', (event) => {
        const e = event as Event & { averageLoad: number; peakLoad: number; underrunRatio: number };
        if (!capacity) return;
        capacity.updates += 1;
        capacity.averageLoad = Math.max(capacity.averageLoad, e.averageLoad);
        capacity.peakLoad = Math.max(capacity.peakLoad, e.peakLoad);
        capacity.underrunRatio = Math.max(capacity.underrunRatio, e.underrunRatio);
      });
      meter.start({ updateInterval: 1 });
    }
    gain = context.createGain();
    gain.gain.value = options.silent || $<HTMLInputElement>('silent').checked ? 0 : 1;
    node.node.connect(gain).connect(context.destination);
    node.setSpeed(Number($<HTMLInputElement>('speed').value));
    $<HTMLInputElement>('seek').max = String(frames / sampleRate);
    for (const id of ['play', 'pause']) $<HTMLButtonElement>(id).disabled = false;
    log(`loaded ${frames} frames (${(frames / sampleRate).toFixed(2)} s) as ${count} source${count === 1 ? '' : 's'}. Ready.`);
    return { ...ready, frames, sources: count };
  },
  channel: (id, gainValue, pan) => node?.setChannel(id, { gain: gainValue, pan }),
  play: () => node?.play(),
  pause: () => node?.pause(),
  seek: (seconds) => node?.seek(Math.round(seconds * sampleRate)),
  speed: (value) => node?.setSpeed(value),
  loop: (a, b) => node?.setLoop(a === null || b === undefined ? null : { start: Math.round(a * sampleRate), end: Math.round(b * sampleRate) }),
  async stats() {
    if (!node || !context) throw new Error('not initialised');
    const stats = await node.stats();
    return {
      ...stats,
      extrapolated: node.position(),
      contextTime: context.currentTime,
      outputLatency: context.outputLatency,
      baseLatency: context.baseLatency,
      capacity,
    };
  },
  close: () => {
    node?.close();
    node = null;
  },
  reports: () => reports,
  clearReports: () => {
    reports.length = 0;
  },
};

declare global {
  interface Window {
    bench: Bench;
  }
}
window.bench = bench;

$('init').addEventListener('click', () => bench.init().catch((error) => log(`init failed: ${error}`)));
$('play').addEventListener('click', () => bench.play());
$('pause').addEventListener('click', () => bench.pause());
$<HTMLInputElement>('silent').addEventListener('change', (event) => {
  if (gain) gain.gain.value = (event.target as HTMLInputElement).checked ? 0 : 1;
});
$<HTMLInputElement>('speed').addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  $('speedValue').textContent = value.toFixed(2);
  bench.speed(value);
});
$<HTMLInputElement>('seek').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  bench.seek(value);
});
const applyLoop = () => {
  const on = $<HTMLInputElement>('loop').checked;
  bench.loop(on ? Number($<HTMLInputElement>('loopA').value) : null, Number($<HTMLInputElement>('loopB').value));
};
for (const id of ['loop', 'loopA', 'loopB']) $(id).addEventListener('change', applyLoop);

setInterval(() => {
  if (!node || !context) return;
  const position = node.position();
  $('position').textContent = `position: ${(position / sampleRate).toFixed(3)} s (frame ${Math.round(position)}) ctx ${context.currentTime.toFixed(2)} s`;
  $<HTMLInputElement>('seek').value = String(position / sampleRate);
  $('seekValue').textContent = `${(position / sampleRate).toFixed(1)} s`;
}, 100);
setInterval(() => {
  if (!node) return;
  bench.stats().then((stats) => {
    $('stats').textContent = JSON.stringify(stats, null, 1);
  });
}, 1000);
