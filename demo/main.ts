import { BungeeNode } from '../src/node.ts';
import { compileBungee } from '../src/wasm.ts';

const SAMPLE_URL = './audio/original-1.0x.mp3';
const WASM_URL = './bungee.wasm';
const WORKLET_URL = './worklet.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const playButton = $<HTMLButtonElement>('demo-play');
const speedInput = $<HTMLInputElement>('demo-speed');
const speedOutput = $<HTMLOutputElement>('demo-speed-output');
const seekInput = $<HTMLInputElement>('demo-seek');
const elapsedOutput = $<HTMLOutputElement>('demo-elapsed');
const durationOutput = $<HTMLOutputElement>('demo-duration');
const statusElement = $('demo-status');
const staticPlayers = Array.from(document.querySelectorAll<HTMLAudioElement>('.static-sample audio'));

let context: AudioContext | null = null;
let node: BungeeNode | null = null;
let sampleRate = 0;
let frameCount = 0;
let loading: Promise<void> | null = null;
let playing = false;
let ended = false;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function setPlaying(value: boolean): void {
  playing = value;
  playButton.textContent = value ? 'Pause' : 'Play';
  playButton.setAttribute('aria-label', value ? 'Pause WebAssembly demo' : 'Play WebAssembly demo');
}

function showError(error: unknown): void {
  console.error(error);
  setPlaying(false);
  statusElement.textContent = error instanceof Error ? `Could not start the demo: ${error.message}` : 'Could not start the demo.';
  statusElement.classList.add('error');
  playButton.disabled = true;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

async function initialize(): Promise<void> {
  if (node) return;
  if (loading) return loading;

  loading = (async () => {
    statusElement.textContent = 'Loading the sample and WebAssembly module...';
    context = new AudioContext();
    await context.resume();

    const [module, sampleResponse] = await Promise.all([
      compileBungee(fetchOk(WASM_URL)),
      fetchOk(SAMPLE_URL),
      BungeeNode.addModule(context, WORKLET_URL),
    ]);

    const decoded = await context.decodeAudioData(await sampleResponse.arrayBuffer());
    const readyNode = new BungeeNode(context, module);
    const ready = await readyNode.ready;
    sampleRate = context.sampleRate;
    frameCount = decoded.length;
    readyNode.load(frameCount, [
      {
        id: 'sample',
        left: decoded.getChannelData(0).slice(),
        right: decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)).slice(),
      },
    ]);
    readyNode.node.connect(context.destination);
    readyNode.setSpeed(Number(speedInput.value));
    readyNode.on('ended', () => {
      ended = true;
      setPlaying(false);
      updatePosition(frameCount);
      statusElement.textContent = 'Finished. Press Play to listen again.';
    });
    readyNode.on('error', (message) => showError(new Error(message)));
    node = readyNode;

    seekInput.max = String(frameCount);
    durationOutput.value = formatTime(frameCount / sampleRate);
    seekInput.disabled = false;
    speedInput.disabled = false;
    statusElement.textContent = `Ready. Bungee ${ready.version} is running in an AudioWorklet.`;
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

function updatePosition(position = node?.position() ?? 0): void {
  const clamped = Math.min(frameCount, Math.max(0, position));
  if (!seekInput.matches(':active')) seekInput.value = String(clamped);
  elapsedOutput.value = formatTime(clamped / Math.max(1, sampleRate));
}

async function togglePlayback(): Promise<void> {
  playButton.disabled = true;
  try {
    await initialize();
    if (!context || !node) return;
    await context.resume();

    if (playing) {
      node.pause();
      setPlaying(false);
      statusElement.textContent = 'Paused.';
    } else {
      for (const player of staticPlayers) player.pause();
      if (ended || node.position() >= frameCount) {
        node.seek(0);
        ended = false;
      }
      node.play();
      setPlaying(true);
      statusElement.textContent = `Playing at ${Number(speedInput.value).toFixed(2)}x.`;
    }
  } finally {
    if (!statusElement.classList.contains('error')) playButton.disabled = false;
  }
}

playButton.addEventListener('click', () => togglePlayback().catch(showError));

speedInput.addEventListener('input', () => {
  const speed = Number(speedInput.value);
  speedOutput.value = `${speed.toFixed(2)}x`;
  node?.setSpeed(speed);
  if (playing) statusElement.textContent = `Playing at ${speed.toFixed(2)}x.`;
});

seekInput.addEventListener('input', () => {
  const position = Number(seekInput.value);
  elapsedOutput.value = formatTime(position / Math.max(1, sampleRate));
});

seekInput.addEventListener('change', () => {
  if (!node) return;
  const position = Number(seekInput.value);
  node.seek(position);
  ended = false;
  updatePosition(position);
});

for (const player of staticPlayers) {
  player.addEventListener('play', () => {
    if (node && playing) node.pause();
    setPlaying(false);
    statusElement.textContent = 'WebAssembly demo paused while a static sample plays.';
    for (const other of staticPlayers) {
      if (other !== player) other.pause();
    }
  });
}

const tick = (): void => {
  if (node) updatePosition();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
