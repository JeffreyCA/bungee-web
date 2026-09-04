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
const fileInput = $<HTMLInputElement>('demo-file');
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
let initializing: Promise<void> | null = null;
let bungeeVersion = '';
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
  statusElement.textContent = error instanceof Error ? `Could not load audio: ${error.message}` : 'Could not load audio.';
  statusElement.classList.add('error');
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

async function initialize(): Promise<void> {
  if (node) return;
  if (initializing) return initializing;

  initializing = (async () => {
    statusElement.textContent = 'Loading the WebAssembly module...';
    context ??= new AudioContext();

    const [module] = await Promise.all([
      compileBungee(fetchOk(WASM_URL)),
      BungeeNode.addModule(context, WORKLET_URL),
    ]);

    const readyNode = new BungeeNode(context, module);
    const ready = await readyNode.ready;
    sampleRate = context.sampleRate;
    bungeeVersion = ready.version;
    readyNode.node.connect(context.destination);
    readyNode.on('ended', () => {
      ended = true;
      setPlaying(false);
      updatePosition(frameCount);
      statusElement.textContent = 'Finished. Press Play to listen again.';
    });
    readyNode.on('error', (message) => showError(new Error(message)));
    node = readyNode;
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

async function loadAudio(data: ArrayBuffer, label: string): Promise<void> {
  await initialize();
  if (!context || !node) throw new Error('WebAssembly module did not initialize');

  statusElement.classList.remove('error');
  statusElement.textContent = `Decoding ${label}...`;
  const decoded = await context.decodeAudioData(data);
  if (playing) node.pause();
  setPlaying(false);

  frameCount = decoded.length;
  node.load(frameCount, [
    {
      id: 'sample',
      left: decoded.getChannelData(0).slice(),
      right: decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)).slice(),
    },
  ]);
  node.setSpeed(Number(speedInput.value));
  ended = false;
  seekInput.max = String(frameCount);
  seekInput.value = '0';
  seekInput.disabled = false;
  elapsedOutput.value = '0:00';
  durationOutput.value = formatTime(frameCount / sampleRate);
  statusElement.classList.remove('error');
  statusElement.textContent = `${label} ready. Bungee ${bungeeVersion}.`;
}

async function loadDefaultSample(): Promise<void> {
  const response = await fetchOk(SAMPLE_URL);
  await loadAudio(await response.arrayBuffer(), 'Demo sample');
}

function updatePosition(position = node?.position() ?? 0): void {
  const clamped = Math.min(frameCount, Math.max(0, position));
  if (!seekInput.matches(':active')) seekInput.value = String(clamped);
  elapsedOutput.value = formatTime(clamped / Math.max(1, sampleRate));
}

async function togglePlayback(): Promise<void> {
  playButton.disabled = true;
  fileInput.disabled = true;
  try {
    context ??= new AudioContext();
    await context.resume();
    if (frameCount === 0) await loadDefaultSample();
    if (!context || !node) return;

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
    playButton.disabled = false;
    fileInput.disabled = false;
  }
}

playButton.addEventListener('click', () => togglePlayback().catch(showError));

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  if (node && playing) node.pause();
  setPlaying(false);
  statusElement.classList.remove('error');
  statusElement.textContent = `Reading ${file.name}...`;
  playButton.disabled = true;
  fileInput.disabled = true;
  file.arrayBuffer()
    .then((data) => loadAudio(data, file.name))
    .catch(showError)
    .finally(() => {
      playButton.disabled = false;
      fileInput.disabled = false;
    });
});

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
