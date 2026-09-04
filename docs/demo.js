// src/node.ts
var BungeeNode = class {
  context;
  node;
  ready;
  listeners = {
    position: /* @__PURE__ */ new Set(),
    ended: /* @__PURE__ */ new Set(),
    log: /* @__PURE__ */ new Set(),
    error: /* @__PURE__ */ new Set()
  };
  generation = 0;
  lastReport = null;
  statsWaiters = [];
  closed = false;
  static addModule(context2, workletUrl) {
    return context2.audioWorklet.addModule(workletUrl);
  }
  constructor(context2, module) {
    this.context = context2;
    this.node = new AudioWorkletNode(context2, "bungee-transport", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module }
    });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const data = event.data;
        if (data.type === "ready") {
          resolve({ version: data.version, hop: data.hop, sampleRate: data.sampleRate });
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };
      this.node.port.addEventListener("message", onMessage, { once: true });
      this.node.onprocessorerror = () => {
        const message = "bungee-transport processor failed; see the browser console";
        reject(new Error(message));
        this.failStats(new Error(message));
        for (const listener of this.listeners.error) listener(message);
      };
    });
    this.node.port.onmessage = (event) => this.receive(event.data);
  }
  on(event, listener) {
    const set = this.listeners[event];
    set.add(listener);
    return () => set.delete(listener);
  }
  /** True once `load()` has been called; transport commands before that throw. */
  get loaded() {
    return this.generation > 0;
  }
  /**
   * Hands the sources to the worklet, replacing any earlier set. A channel
   * that owns its whole ArrayBuffer is transferred (the caller's array goes
   * empty); a view onto a larger or shared buffer is copied first.
   */
  load(frameCount2, sources) {
    this.assertOpen();
    this.generation += 1;
    this.lastReport = null;
    const { sources: prepared, transfer } = prepareSources(sources);
    this.send({ type: "load", generation: this.generation, frameCount: frameCount2, sources: prepared }, transfer);
  }
  addSource(source) {
    this.assertLoaded();
    const { sources, transfer } = prepareSources([source]);
    this.send({ type: "source", source: sources[0] }, transfer);
  }
  setChannel(id, state) {
    this.assertLoaded();
    this.send({ type: "channel", id, state });
  }
  removeSource(id) {
    this.assertLoaded();
    this.send({ type: "remove", id });
  }
  play() {
    this.assertLoaded();
    this.send({ type: "play" });
    this.assume({ playing: true });
  }
  pause() {
    this.assertLoaded();
    this.send({ type: "pause" });
    this.assume({ playing: false });
  }
  seek(frame) {
    this.assertLoaded();
    this.send({ type: "seek", frame });
    this.assume({ position: frame });
  }
  setSpeed(speed) {
    this.assertLoaded();
    this.send({ type: "speed", speed });
    this.assume({ speed });
  }
  setLoop(range) {
    this.assertLoaded();
    this.send({ type: "loop", range });
  }
  stats() {
    this.assertOpen();
    return new Promise((resolve, reject) => {
      this.statsWaiters.push({ resolve, reject });
      this.send({ type: "stats" });
    });
  }
  /** The most recent report from the worklet, or null before the first load. */
  get report() {
    return this.lastReport;
  }
  /**
   * Estimated source position now, extrapolated from the last report by the
   * context clock. Exact at report boundaries; between them it assumes the
   * reported speed held, which is what the worklet does too.
   */
  position() {
    const report = this.lastReport;
    if (!report) return 0;
    if (!report.playing) return report.position;
    const elapsed = this.context.currentTime - report.contextTime;
    return report.position + elapsed * this.context.sampleRate * report.speed;
  }
  /** Retires the processor, releasing the wasm heap and every source it holds. The node cannot be reused. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: "close" });
    this.node.disconnect();
    this.failStats(new Error("BungeeNode closed"));
  }
  /**
   * Updates the local report as if the worklet had already answered, so
   * position() reflects a command at once instead of one message round trip
   * later. The worklet's own report replaces it when it arrives.
   */
  assume(change) {
    const position = this.position();
    const previous = this.lastReport;
    this.lastReport = {
      position,
      speed: previous?.speed ?? 1,
      playing: previous?.playing ?? false,
      ...change,
      contextTime: this.context.currentTime
    };
  }
  assertOpen() {
    if (this.closed) throw new Error("BungeeNode is closed");
  }
  assertLoaded() {
    this.assertOpen();
    if (!this.loaded) throw new Error("BungeeNode has no sources; call load() first");
  }
  failStats(error) {
    const waiters = this.statsWaiters;
    this.statsWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
  send(command, transfer = []) {
    this.node.port.postMessage(command, transfer);
  }
  receive(event) {
    switch (event.type) {
      case "position":
        if (event.generation !== this.generation) return;
        this.lastReport = event.report;
        for (const listener of this.listeners.position) listener(event.report);
        break;
      case "ended":
        if (event.generation !== this.generation) return;
        this.lastReport = { position: event.position, contextTime: event.contextTime, speed: this.lastReport?.speed ?? 1, playing: false };
        for (const listener of this.listeners.ended) listener(event);
        break;
      case "stats": {
        const waiters = this.statsWaiters;
        this.statsWaiters = [];
        for (const waiter of waiters) waiter.resolve(event.stats);
        break;
      }
      case "log":
        for (const listener of this.listeners.log) listener(event.line);
        break;
      case "error":
        for (const listener of this.listeners.error) listener(event.message);
        break;
      case "ready":
        break;
    }
  }
};
function prepareSources(sources) {
  const transfer = /* @__PURE__ */ new Set();
  const prepared = sources.map((source) => ({
    ...source,
    left: ownedChannel(source.left, transfer),
    right: ownedChannel(source.right, transfer)
  }));
  return { sources: prepared, transfer: [...transfer] };
}
function ownedChannel(channel, transfer) {
  const buffer = channel.buffer;
  const ownsWholeBuffer = buffer instanceof ArrayBuffer && channel.byteOffset === 0 && channel.byteLength === buffer.byteLength;
  if (ownsWholeBuffer && !transfer.has(buffer)) {
    transfer.add(buffer);
    return channel;
  }
  return channel.slice();
}

// src/wasm.ts
async function compileBungee(source) {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return WebAssembly.compile(source);
  }
  const response = await source;
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

// demo/main.ts
var SAMPLE_URL = "./audio/original-1.0x.mp3";
var WASM_URL = "./bungee.wasm";
var WORKLET_URL = "./worklet.js";
var $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
};
var playButton = $("demo-play");
var fileInput = $("demo-file");
var speedInput = $("demo-speed");
var speedOutput = $("demo-speed-output");
var seekInput = $("demo-seek");
var elapsedOutput = $("demo-elapsed");
var durationOutput = $("demo-duration");
var statusElement = $("demo-status");
var staticPlayers = Array.from(document.querySelectorAll(".static-sample audio"));
var context = null;
var node = null;
var sampleRate = 0;
var frameCount = 0;
var initializing = null;
var bungeeVersion = "";
var playing = false;
var ended = false;
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function setPlaying(value) {
  playing = value;
  playButton.textContent = value ? "Pause" : "Play";
  playButton.setAttribute("aria-label", value ? "Pause WebAssembly demo" : "Play WebAssembly demo");
}
function showError(error) {
  console.error(error);
  setPlaying(false);
  statusElement.textContent = error instanceof Error ? `Could not load audio: ${error.message}` : "Could not load audio.";
  statusElement.classList.add("error");
}
async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}
async function initialize() {
  if (node) return;
  if (initializing) return initializing;
  initializing = (async () => {
    statusElement.textContent = "Loading the WebAssembly module...";
    context ??= new AudioContext();
    const [module] = await Promise.all([
      compileBungee(fetchOk(WASM_URL)),
      BungeeNode.addModule(context, WORKLET_URL)
    ]);
    const readyNode = new BungeeNode(context, module);
    const ready = await readyNode.ready;
    sampleRate = context.sampleRate;
    bungeeVersion = ready.version;
    readyNode.node.connect(context.destination);
    readyNode.on("ended", () => {
      ended = true;
      setPlaying(false);
      updatePosition(frameCount);
      statusElement.textContent = "Finished. Press Play to listen again.";
    });
    readyNode.on("error", (message) => showError(new Error(message)));
    node = readyNode;
  })();
  try {
    await initializing;
  } finally {
    initializing = null;
  }
}
async function loadAudio(data, label) {
  await initialize();
  if (!context || !node) throw new Error("WebAssembly module did not initialize");
  statusElement.classList.remove("error");
  statusElement.textContent = `Decoding ${label}...`;
  const decoded = await context.decodeAudioData(data);
  if (playing) node.pause();
  setPlaying(false);
  frameCount = decoded.length;
  node.load(frameCount, [
    {
      id: "sample",
      left: decoded.getChannelData(0).slice(),
      right: decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)).slice()
    }
  ]);
  node.setSpeed(Number(speedInput.value));
  ended = false;
  seekInput.max = String(frameCount);
  seekInput.value = "0";
  seekInput.disabled = false;
  elapsedOutput.value = "0:00";
  durationOutput.value = formatTime(frameCount / sampleRate);
  statusElement.classList.remove("error");
  statusElement.textContent = `${label} ready. Bungee ${bungeeVersion}.`;
}
async function loadDefaultSample() {
  const response = await fetchOk(SAMPLE_URL);
  await loadAudio(await response.arrayBuffer(), "Demo sample");
}
function updatePosition(position = node?.position() ?? 0) {
  const clamped = Math.min(frameCount, Math.max(0, position));
  if (!seekInput.matches(":active")) seekInput.value = String(clamped);
  elapsedOutput.value = formatTime(clamped / Math.max(1, sampleRate));
}
async function togglePlayback() {
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
      statusElement.textContent = "Paused.";
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
playButton.addEventListener("click", () => togglePlayback().catch(showError));
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (node && playing) node.pause();
  setPlaying(false);
  statusElement.classList.remove("error");
  statusElement.textContent = `Reading ${file.name}...`;
  playButton.disabled = true;
  fileInput.disabled = true;
  file.arrayBuffer().then((data) => loadAudio(data, file.name)).catch(showError).finally(() => {
    playButton.disabled = false;
    fileInput.disabled = false;
  });
});
speedInput.addEventListener("input", () => {
  const speed = Number(speedInput.value);
  speedOutput.value = `${speed.toFixed(2)}x`;
  node?.setSpeed(speed);
  if (playing) statusElement.textContent = `Playing at ${speed.toFixed(2)}x.`;
});
seekInput.addEventListener("input", () => {
  const position = Number(seekInput.value);
  elapsedOutput.value = formatTime(position / Math.max(1, sampleRate));
});
seekInput.addEventListener("change", () => {
  if (!node) return;
  const position = Number(seekInput.value);
  node.seek(position);
  ended = false;
  updatePosition(position);
});
for (const player of staticPlayers) {
  player.addEventListener("play", () => {
    if (node && playing) node.pause();
    setPlaying(false);
    statusElement.textContent = "WebAssembly demo paused while a static sample plays.";
    for (const other of staticPlayers) {
      if (other !== player) other.pause();
    }
  });
}
var tick = () => {
  if (node) updatePosition();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
