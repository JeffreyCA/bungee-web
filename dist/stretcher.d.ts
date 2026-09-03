import { type BungeeExports } from './wasm.ts';
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
export declare class BungeeStretcher {
    readonly channels: number;
    /** Frames of output per grain at pitch 1 (512 at 44.1/48 kHz). */
    readonly hop: number;
    /** Largest input chunk specify() can ask for; inputChannel views are this long. */
    readonly maxInputFrames: number;
    private readonly wasm;
    private readonly handle;
    private readonly inputPointer;
    private readonly inputStride;
    private destroyed;
    static version(wasm: BungeeExports): string;
    constructor(wasm: BungeeExports, options: StretcherOptions);
    private get heap();
    setRequest(position: number, speed: number, pitch?: number, reset?: boolean): void;
    get requestPosition(): number;
    /** Moves the request one hop earlier and marks it a reset, so the target is reached at full strength. */
    preroll(): void;
    /** Advances the request by one hop at its speed and clears the reset flag. */
    next(): void;
    specify(): InputChunk;
    /** Planar input for the current grain; frame i of the chunk goes at index i. */
    inputChannel(index: number): Float32Array;
    analyse(muteHead?: number, muteTail?: number): void;
    synthesise(): OutputChunk;
    private checkChannel;
    get flushed(): boolean;
    destroy(): void;
}
