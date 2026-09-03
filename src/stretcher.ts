import { readCString, type BungeeExports } from './wasm.ts';

export interface StretcherOptions {
  /** Sample rate of the source audio. */
  sampleRate: number;
  /** Output rate; defaults to the input rate (no resampling). */
  outputRate?: number;
  channels?: number;
  /** -1 halves the grain (lower latency), +1 doubles it. 0 is what upstream recommends. */
  hopAdjust?: -1 | 0 | 1;
}

export interface InputChunk {
  /** First source frame the grain needs (may be negative). */
  begin: number;
  /** Frame after the last one it needs (may exceed the source length). */
  end: number;
}

export interface OutputChunk {
  frames: number;
  /** Source position of the first output frame; NaN while the pipeline is filling after a reset. */
  begin: number;
  /** Source position of the frame after the last output frame. */
  end: number;
  channel(index: number): Float32Array;
}

/**
 * One Bungee Basic stretcher over the wasm exports, driven grain by grain:
 * setRequest -> specify -> fill inputChannel(c) -> analyse -> synthesise -> next.
 */
export class BungeeStretcher {
  readonly channels: number;
  /** Frames of output per grain at pitch 1 (512 at 44.1/48 kHz). */
  readonly hop: number;
  /** Largest input chunk specify() can ask for; inputChannel views are this long. */
  readonly maxInputFrames: number;
  private readonly wasm: BungeeExports;
  private readonly handle: number;
  private readonly inputPointer: number;
  private readonly inputStride: number;
  private destroyed = false;

  static version(wasm: BungeeExports): string {
    return readCString(wasm, wasm.bw_version());
  }

  constructor(wasm: BungeeExports, options: StretcherOptions) {
    this.wasm = wasm;
    this.channels = options.channels ?? 2;
    this.handle = wasm.bw_create(
      options.sampleRate,
      options.outputRate ?? options.sampleRate,
      this.channels,
      options.hopAdjust ?? 0,
    );
    this.hop = wasm.bw_synthesis_hop(this.handle);
    this.maxInputFrames = wasm.bw_max_input_frames(this.handle);
    this.inputPointer = wasm.bw_input(this.handle);
    this.inputStride = wasm.bw_input_stride(this.handle);
  }

  private get heap(): Float32Array {
    return new Float32Array(this.wasm.memory.buffer);
  }

  setRequest(position: number, speed: number, pitch = 1, reset = false): void {
    this.wasm.bw_set_request(this.handle, position, speed, pitch, reset ? 1 : 0);
  }

  get requestPosition(): number {
    return this.wasm.bw_request_position(this.handle);
  }

  /** Moves the request one hop earlier and marks it a reset, so the target is reached at full strength. */
  preroll(): void {
    this.wasm.bw_preroll(this.handle);
  }

  /** Advances the request by one hop at its speed and clears the reset flag. */
  next(): void {
    this.wasm.bw_next(this.handle);
  }

  specify(): InputChunk {
    this.wasm.bw_specify(this.handle);
    return { begin: this.wasm.bw_chunk_begin(this.handle), end: this.wasm.bw_chunk_end(this.handle) };
  }

  /** Planar input for the current grain; frame i of the chunk goes at index i. */
  inputChannel(index: number): Float32Array {
    this.checkChannel(index);
    const start = this.inputPointer / 4 + index * this.inputStride;
    return this.heap.subarray(start, start + this.inputStride);
  }

  analyse(muteHead = 0, muteTail = 0): void {
    this.wasm.bw_analyse(this.handle, muteHead, muteTail);
  }

  synthesise(): OutputChunk {
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
      },
    };
  }

  private checkChannel(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.channels) {
      throw new RangeError(`channel ${index} out of range for a ${this.channels}-channel stretcher`);
    }
  }

  get flushed(): boolean {
    return this.wasm.bw_is_flushed(this.handle) !== 0;
  }

  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.wasm.bw_destroy(this.handle);
    }
  }
}
