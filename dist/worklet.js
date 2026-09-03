"use strict";
(() => {
  // src/wasm.ts
  function instantiateBungeeSync(module, log = () => {
  }) {
    const instance = new WebAssembly.Instance(module, buildImports(module, () => exports, log));
    const exports = instance.exports;
    exports._initialize?.();
    return exports;
  }
  function readCString(exports, pointer) {
    const bytes = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (bytes[end] !== 0) end += 1;
    return decodeUtf8(bytes.subarray(pointer, end));
  }
  function decodeUtf8(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; ) {
      const b0 = bytes[i];
      let code;
      if (b0 < 128) {
        code = b0;
        i += 1;
      } else if (b0 < 224) {
        code = (b0 & 31) << 6 | bytes[i + 1] & 63;
        i += 2;
      } else if (b0 < 240) {
        code = (b0 & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63;
        i += 3;
      } else {
        code = (b0 & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63;
        i += 4;
      }
      text += String.fromCodePoint(code);
    }
    return text;
  }
  function buildImports(module, getExports, log) {
    const imports = {};
    let pending = "";
    const fdWrite = (_fd, iovs, iovsLength, writtenPointer) => {
      const memory = getExports().memory.buffer;
      const view = new DataView(memory);
      let written = 0;
      for (let i = 0; i < iovsLength; i += 1) {
        const pointer = view.getUint32(iovs + i * 8, true);
        const length = view.getUint32(iovs + i * 8 + 4, true);
        pending += decodeUtf8(new Uint8Array(memory, pointer, length));
        written += length;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        log(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      view.setUint32(writtenPointer, written, true);
      return 0;
    };
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind !== "function") {
        throw new Error(`bungee.wasm imports unsupported ${entry.kind} ${entry.module}.${entry.name}`);
      }
      const target = imports[entry.module] ??= {};
      switch (entry.name) {
        case "fd_write":
          target[entry.name] = fdWrite;
          break;
        case "proc_exit":
          target[entry.name] = (code) => {
            throw new Error(`bungee.wasm exited with code ${code}`);
          };
          break;
        default:
          target[entry.name] = () => 0;
      }
    }
    return imports;
  }

  // src/stretcher.ts
  var BungeeStretcher = class {
    channels;
    /** Frames of output per grain at pitch 1 (512 at 44.1/48 kHz). */
    hop;
    /** Largest input chunk specify() can ask for; inputChannel views are this long. */
    maxInputFrames;
    wasm;
    handle;
    inputPointer;
    inputStride;
    destroyed = false;
    static version(wasm) {
      return readCString(wasm, wasm.bw_version());
    }
    constructor(wasm, options) {
      this.wasm = wasm;
      this.channels = options.channels ?? 2;
      this.handle = wasm.bw_create(
        options.sampleRate,
        options.outputRate ?? options.sampleRate,
        this.channels,
        options.hopAdjust ?? 0
      );
      this.hop = wasm.bw_synthesis_hop(this.handle);
      this.maxInputFrames = wasm.bw_max_input_frames(this.handle);
      this.inputPointer = wasm.bw_input(this.handle);
      this.inputStride = wasm.bw_input_stride(this.handle);
    }
    get heap() {
      return new Float32Array(this.wasm.memory.buffer);
    }
    setRequest(position, speed, pitch = 1, reset = false) {
      this.wasm.bw_set_request(this.handle, position, speed, pitch, reset ? 1 : 0);
    }
    get requestPosition() {
      return this.wasm.bw_request_position(this.handle);
    }
    /** Moves the request one hop earlier and marks it a reset, so the target is reached at full strength. */
    preroll() {
      this.wasm.bw_preroll(this.handle);
    }
    /** Advances the request by one hop at its speed and clears the reset flag. */
    next() {
      this.wasm.bw_next(this.handle);
    }
    specify() {
      this.wasm.bw_specify(this.handle);
      return { begin: this.wasm.bw_chunk_begin(this.handle), end: this.wasm.bw_chunk_end(this.handle) };
    }
    /** Planar input for the current grain; frame i of the chunk goes at index i. */
    inputChannel(index) {
      this.checkChannel(index);
      const start = this.inputPointer / 4 + index * this.inputStride;
      return this.heap.subarray(start, start + this.inputStride);
    }
    analyse(muteHead = 0, muteTail = 0) {
      this.wasm.bw_analyse(this.handle, muteHead, muteTail);
    }
    synthesise() {
      const wasm = this.wasm;
      const handle = this.handle;
      wasm.bw_synthesise(handle);
      const frames = wasm.bw_output_frames(handle);
      const data = wasm.bw_output_data(handle) / 4;
      const stride = wasm.bw_output_stride(handle);
      const heap = this.heap;
      return {
        frames,
        begin: wasm.bw_output_begin(handle),
        end: wasm.bw_output_end(handle),
        channel: (index) => {
          this.checkChannel(index);
          return heap.subarray(data + index * stride, data + index * stride + frames);
        }
      };
    }
    checkChannel(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.channels) {
        throw new RangeError(`channel ${index} out of range for a ${this.channels}-channel stretcher`);
      }
    }
    get flushed() {
      return this.wasm.bw_is_flushed(this.handle) !== 0;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.wasm.bw_destroy(this.handle);
      }
    }
  };

  // src/ring.ts
  var OutputRing = class {
    left;
    right;
    position;
    capacity;
    readIndex = 0;
    writeIndex = 0;
    constructor(capacity) {
      this.capacity = capacity;
      this.left = new Float32Array(capacity);
      this.right = new Float32Array(capacity);
      this.position = new Float64Array(capacity);
    }
    get available() {
      return this.writeIndex - this.readIndex;
    }
    get free() {
      return this.capacity - this.available;
    }
    clear() {
      this.readIndex = 0;
      this.writeIndex = 0;
    }
    push(left, right, position) {
      const slot = this.writeIndex % this.capacity;
      this.left[slot] = left;
      this.right[slot] = right;
      this.position[slot] = position;
      this.writeIndex += 1;
    }
    /** Position of the frame `offset` ahead of the read cursor. */
    positionAt(offset) {
      return this.position[(this.readIndex + offset) % this.capacity] ?? NaN;
    }
    /** Copies `frames` frames into the outputs starting at `offset`, then advances. */
    pop(left, right, offset, frames) {
      for (let i = 0; i < frames; i += 1) {
        const slot = (this.readIndex + i) % this.capacity;
        left[offset + i] = this.left[slot] ?? 0;
        right[offset + i] = this.right[slot] ?? 0;
      }
      this.readIndex += frames;
    }
  };

  // src/transport.ts
  var MAX_GRAINS_PER_RENDER = 16;
  var MIN_LOOP_FRAMES = 2;
  var SEGMENT_HISTORY = 8;
  function fold(x, loop) {
    if (!loop || x < loop.end) return x;
    const length = loop.end - loop.start;
    return loop.start + (x - loop.start) % length;
  }
  function assertFinite(value, what) {
    if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}`);
  }
  var Transport = class {
    stats = { grains: 0, renders: 0, maxGrainsPerRender: 0, trimmedFrames: 0, underruns: 0 };
    frameCount;
    stretcher;
    channels = /* @__PURE__ */ new Map();
    ring;
    mixLeft;
    mixRight;
    frameIndex;
    segments = [{ v: -Infinity, offset: 0, loop: null }];
    loopRange = null;
    trimBefore = -Infinity;
    cursor = 0;
    primed = false;
    playingState = false;
    endedState = false;
    speedValue = 1;
    constructor(stretcher, frameCount) {
      if (stretcher.channels !== 2) throw new Error(`Transport needs a stereo stretcher, got ${stretcher.channels} channels`);
      assertFinite(frameCount, "frameCount");
      this.stretcher = stretcher;
      this.frameCount = Math.max(0, Math.floor(frameCount));
      this.ring = new OutputRing(stretcher.hop * 8);
      this.mixLeft = new Float32Array(stretcher.maxInputFrames);
      this.mixRight = new Float32Array(stretcher.maxInputFrames);
      this.frameIndex = new Int32Array(stretcher.maxInputFrames);
    }
    // --- sources ---------------------------------------------------------------
    setSource(id, source, state = { gain: 1, pan: 0 }) {
      this.channels.set(id, { source, gain: 0, pan: 0 });
      this.setChannel(id, state);
    }
    setChannel(id, state) {
      const channel = this.channels.get(id);
      if (!channel) return;
      channel.gain = Number.isFinite(state.gain) ? Math.max(0, state.gain) : 0;
      channel.pan = Number.isFinite(state.pan) ? Math.min(1, Math.max(-1, state.pan)) : 0;
    }
    removeSource(id) {
      this.channels.delete(id);
    }
    // --- transport -------------------------------------------------------------
    get playing() {
      return this.playingState;
    }
    get ended() {
      return this.endedState;
    }
    get speed() {
      return this.speedValue;
    }
    set speed(value) {
      if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`speed must be positive, got ${value}`);
      this.speedValue = value;
    }
    get loop() {
      return this.loopRange;
    }
    /** Source frame of the next frame render() will emit; the paused position while paused. */
    get position() {
      return this.cursor;
    }
    play() {
      if (this.playingState) return;
      if (this.endedState || !this.primed) {
        this.seek(this.endedState ? this.loopRange?.start ?? 0 : this.cursor);
      }
      this.playingState = true;
    }
    pause() {
      this.playingState = false;
    }
    /** Jumps to a source frame. The stretcher is flushed and re-primed, so the next output frame is the target. */
    seek(frame) {
      assertFinite(frame, "seek frame");
      let target = Math.round(Math.min(Math.max(frame, 0), this.frameCount));
      if (this.loopRange && target >= this.loopRange.end) target = this.loopRange.start;
      this.segments = [{ v: -Infinity, offset: 0, loop: this.loopRange }];
      this.cursor = target;
      this.endedState = false;
      this.primed = true;
      this.ring.clear();
      this.flush();
      this.stretcher.setRequest(target, this.speedValue, 1, true);
      this.stretcher.preroll();
      this.trimBefore = target;
    }
    /**
     * Sets or clears the loop without stopping. The change applies from the
     * next grain the stretcher analyses, so it is heard about two grains later.
     * A loop that starts ahead of the playhead is entered when playback reaches
     * it; one whose end is already behind the audible position restarts at its
     * start, like a seek.
     */
    setLoop(range) {
      const next = range === null ? null : this.normalizeLoop(range);
      this.loopRange = next;
      if (!this.primed) {
        this.segments = [{ v: -Infinity, offset: 0, loop: next }];
        return;
      }
      if (next && this.cursor >= next.end) {
        this.seek(next.start);
        return;
      }
      const boundary = this.stretcher.requestPosition;
      const real = this.realAt(boundary);
      const segment = { v: boundary, offset: real - boundary, loop: next };
      const last = this.segments[this.segments.length - 1];
      if (last && last.v === boundary) this.segments[this.segments.length - 1] = segment;
      else this.segments.push(segment);
      if (this.segments.length > SEGMENT_HISTORY) this.segments.splice(0, this.segments.length - SEGMENT_HISTORY);
    }
    // --- rendering -------------------------------------------------------------
    /**
     * Fills `frames` frames of stereo output and returns the source position of
     * the first emitted frame (NaN when none was: paused, ended, or starved).
     * `positions`, when given, receives the source position of every frame.
     */
    render(left, right, frames, positions) {
      this.stats.renders += 1;
      if (!this.playingState) {
        left.fill(0, 0, frames);
        right.fill(0, 0, frames);
        positions?.fill(this.cursor, 0, frames);
        return NaN;
      }
      let grains = 0;
      while (this.ring.available < frames + 1 && grains < MAX_GRAINS_PER_RENDER) {
        this.produceGrain();
        grains += 1;
      }
      if (grains > this.stats.maxGrainsPerRender) this.stats.maxGrainsPerRender = grains;
      const available = Math.min(frames, this.ring.available);
      if (available < frames) this.stats.underruns += 1;
      let emit = available;
      if (!this.loopRange) {
        for (let i = 0; i < available; i += 1) {
          if (this.ring.positionAt(i) >= this.frameCount) {
            emit = i;
            break;
          }
        }
      }
      const first = emit > 0 ? this.ring.positionAt(0) : NaN;
      if (positions) {
        for (let i = 0; i < emit; i += 1) positions[i] = this.ring.positionAt(i);
      }
      this.ring.pop(left, right, 0, emit);
      if (emit < available) {
        this.cursor = this.frameCount;
        this.playingState = false;
        this.endedState = true;
        this.ring.clear();
      } else if (this.ring.available > 0) {
        this.cursor = this.ring.positionAt(0);
      } else if (emit > 0) {
        this.cursor = this.realAt(this.stretcher.requestPosition);
      }
      if (emit < frames) {
        left.fill(0, emit, frames);
        right.fill(0, emit, frames);
        positions?.fill(this.cursor, emit, frames);
      }
      return first;
    }
    /** Runs one grain through the stretcher and appends its output to the ring. Public for benchmarks. */
    produceGrain() {
      const stretcher = this.stretcher;
      stretcher.setRequest(stretcher.requestPosition, this.speedValue, 1, false);
      const chunk = stretcher.specify();
      const { muteHead, muteTail } = this.fillInput(chunk.begin, chunk.end);
      stretcher.analyse(muteHead, muteTail);
      const output = stretcher.synthesise();
      stretcher.next();
      this.stats.grains += 1;
      if (Number.isNaN(output.begin) || output.frames === 0) return;
      const outLeft = output.channel(0);
      const outRight = output.channel(1);
      const step = (output.end - output.begin) / output.frames;
      for (let i = 0; i < output.frames; i += 1) {
        const v = output.begin + step * i;
        if (v < this.trimBefore) {
          this.stats.trimmedFrames += 1;
          continue;
        }
        if (this.ring.free === 0) break;
        this.ring.push(outLeft[i] ?? 0, outRight[i] ?? 0, this.realAt(v));
      }
      if (output.end >= this.trimBefore) this.trimBefore = -Infinity;
    }
    // --- internals -------------------------------------------------------------
    flush() {
      const stretcher = this.stretcher;
      for (let i = 0; i < 4; i += 1) {
        stretcher.setRequest(NaN, this.speedValue, 1, false);
        stretcher.specify();
        stretcher.analyse(0, 0);
        stretcher.synthesise();
      }
    }
    normalizeLoop(range) {
      assertFinite(range.start, "loop start");
      assertFinite(range.end, "loop end");
      const start = Math.round(Math.min(Math.max(range.start, 0), this.frameCount));
      const end = Math.round(Math.min(Math.max(range.end, 0), this.frameCount));
      if (end - start < MIN_LOOP_FRAMES) throw new RangeError(`loop must span at least ${MIN_LOOP_FRAMES} frames`);
      return { start, end };
    }
    segmentAt(v) {
      const segments = this.segments;
      for (let i = segments.length - 1; i > 0; i -= 1) {
        if (v >= segments[i].v) return segments[i];
      }
      return segments[0];
    }
    /** Real source frame for a timeline frame. */
    realAt(v) {
      const segment = this.segmentAt(v);
      return fold(v + segment.offset, segment.loop);
    }
    /** Mixes every audible source into the stretcher's input for timeline frames [begin, end). */
    fillInput(begin, end) {
      const frames = end - begin;
      const index = this.frameIndex;
      const frameCount = this.frameCount;
      let muteHead = 0;
      let muteTail = 0;
      let seenAudible = false;
      const segments = this.segments;
      for (let s = 0; s < segments.length; s += 1) {
        const segment = segments[s];
        const from = Math.max(begin, Math.ceil(segment.v));
        const to = Math.min(end, s + 1 < segments.length ? Math.ceil(segments[s + 1].v) : end);
        const loop = segment.loop;
        for (let v = from; v < to; v += 1) {
          const real = fold(v + segment.offset, loop);
          const i = v - begin;
          if (real < 0 || real >= frameCount) {
            index[i] = -1;
            if (!seenAudible) muteHead += 1;
            muteTail += 1;
          } else {
            index[i] = real;
            seenAudible = true;
            muteTail = 0;
          }
        }
      }
      if (!seenAudible) muteTail = 0;
      const left = this.mixLeft;
      const right = this.mixRight;
      left.fill(0, 0, frames);
      right.fill(0, 0, frames);
      for (const channel of this.channels.values()) {
        const { gain, pan } = channel;
        if (gain <= 0) continue;
        let leftFromLeft;
        let leftFromRight;
        let rightFromLeft;
        let rightFromRight;
        if (pan <= 0) {
          const x = (pan + 1) * Math.PI / 2;
          leftFromLeft = gain;
          leftFromRight = gain * Math.cos(x);
          rightFromLeft = 0;
          rightFromRight = gain * Math.sin(x);
        } else {
          const x = pan * Math.PI / 2;
          leftFromLeft = gain * Math.cos(x);
          leftFromRight = 0;
          rightFromLeft = gain * Math.sin(x);
          rightFromRight = gain;
        }
        const sourceLeft = channel.source.left;
        const sourceRight = channel.source.right;
        for (let i = 0; i < frames; i += 1) {
          const real = index[i];
          if (real < 0) continue;
          const l = sourceLeft[real] ?? 0;
          const r = sourceRight[real] ?? 0;
          left[i] = left[i] + leftFromLeft * l + leftFromRight * r;
          right[i] = right[i] + rightFromLeft * l + rightFromRight * r;
        }
      }
      this.stretcher.inputChannel(0).set(left.subarray(0, frames));
      this.stretcher.inputChannel(1).set(right.subarray(0, frames));
      return { muteHead, muteTail };
    }
  };

  // src/worklet/processor.ts
  var REPORT_EVERY = 8;
  var BungeeProcessor = class extends AudioWorkletProcessor {
    stretcher;
    transport = null;
    generation = 0;
    renders = 0;
    closed = false;
    constructor(options) {
      super();
      const module = options.processorOptions?.module;
      if (!module) throw new Error("bungee-transport needs processorOptions.module");
      const wasm = instantiateBungeeSync(module, (line) => this.post({ type: "log", line }));
      this.stretcher = new BungeeStretcher(wasm, { sampleRate, channels: 2 });
      this.port.onmessage = (event) => {
        try {
          this.handle(event.data);
        } catch (error) {
          this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      };
      this.post({ type: "ready", version: BungeeStretcher.version(wasm), hop: this.stretcher.hop, sampleRate });
    }
    post(event) {
      this.port.postMessage(event);
    }
    handle(command) {
      if (this.closed) return;
      switch (command.type) {
        case "load": {
          this.generation = command.generation;
          const transport2 = new Transport(this.stretcher, command.frameCount);
          this.transport = transport2;
          for (const source of command.sources) this.addSource(source);
          this.report(transport2);
          return;
        }
        case "close":
          this.closed = true;
          this.transport = null;
          this.stretcher.destroy();
          this.port.close();
          return;
        case "stats":
          this.postStats();
          return;
        default:
          break;
      }
      const transport = this.transport;
      if (!transport) return;
      switch (command.type) {
        case "source":
          this.addSource(command.source);
          break;
        case "channel":
          transport.setChannel(command.id, command.state);
          break;
        case "remove":
          transport.removeSource(command.id);
          break;
        case "play":
          transport.play();
          this.report(transport);
          break;
        case "pause":
          transport.pause();
          this.report(transport);
          break;
        case "seek":
          transport.seek(command.frame);
          this.report(transport);
          break;
        case "speed":
          transport.speed = command.speed;
          this.report(transport);
          break;
        case "loop":
          transport.setLoop(command.range);
          this.report(transport);
          break;
      }
    }
    addSource(source) {
      this.transport?.setSource(source.id, { left: source.left, right: source.right }, { gain: source.gain ?? 1, pan: source.pan ?? 0 });
    }
    postStats() {
      const transport = this.transport;
      const empty = { grains: 0, renders: 0, maxGrainsPerRender: 0, trimmedFrames: 0, underruns: 0 };
      this.post({
        type: "stats",
        generation: this.generation,
        stats: {
          ...transport?.stats ?? empty,
          loaded: transport !== null,
          contextTime: currentTime,
          position: transport?.position ?? 0,
          playing: transport?.playing ?? false,
          ended: transport?.ended ?? false
        }
      });
    }
    /** After a command: the next frame out, which the next quantum plays. */
    report(transport) {
      this.post({
        type: "position",
        generation: this.generation,
        report: {
          position: transport.position,
          contextTime: currentTime + 128 / sampleRate,
          speed: transport.speed,
          playing: transport.playing
        }
      });
    }
    process(_inputs, outputs) {
      if (this.closed) return false;
      const output = outputs[0];
      const left = output?.[0];
      if (!left) return true;
      const right = output[1] ?? left;
      const transport = this.transport;
      if (!transport) {
        left.fill(0);
        right.fill(0);
        return true;
      }
      const wasPlaying = transport.playing;
      const first = transport.render(left, right, left.length);
      this.renders += 1;
      if (wasPlaying && transport.ended) {
        this.post({ type: "ended", generation: this.generation, position: transport.position, contextTime: currentTime });
      } else if (wasPlaying && this.renders % REPORT_EVERY === 0 && !Number.isNaN(first)) {
        this.post({
          type: "position",
          generation: this.generation,
          report: { position: first, contextTime: currentTime, speed: transport.speed, playing: transport.playing }
        });
      }
      return true;
    }
  };
  registerProcessor("bungee-transport", BungeeProcessor);
})();
