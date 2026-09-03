import { readCString } from "./wasm.js";
/**
 * One Bungee Basic stretcher over the wasm exports, driven grain by grain:
 * setRequest -> specify -> fill inputChannel(c) -> analyse -> synthesise -> next.
 */
export class BungeeStretcher {
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
        this.handle = wasm.bw_create(options.sampleRate, options.outputRate ?? options.sampleRate, this.channels, options.hopAdjust ?? 0);
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
            },
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
}
