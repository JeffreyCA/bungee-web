import type { BungeeStretcher } from './stretcher.ts';
/** Planar stereo PCM at the transport's sample rate. */
export interface StereoSource {
    left: Float32Array;
    right: Float32Array;
}
export interface ChannelState {
    /** Linear gain, clamped at 0; 0 mutes and skips the source entirely. */
    gain: number;
    /** -1 (left) to 1 (right), clamped, applied with the Web Audio StereoPannerNode stereo law. */
    pan: number;
}
/** A loop in source frames, end exclusive. */
export interface LoopRange {
    start: number;
    end: number;
}
export interface TransportStats {
    grains: number;
    renders: number;
    /** Most grains one render had to synthesise to fill its quantum (a seek needs about five). */
    maxGrainsPerRender: number;
    /** Frames dropped in front of a seek target while the pipeline refilled. */
    trimmedFrames: number;
    /** Renders that ran out of audio because the grain loop hit its per-render cap. */
    underruns: number;
}
/**
 * Source-time transport over one stereo stretcher: holds the sources, mixes
 * the input chunk each grain wants, keeps a looped timeline the stretcher
 * sees as one continuous signal, and serves output frames with their source
 * positions.
 *
 * Positions are source frames. The stretcher is driven along a timeline `v`
 * that only moves forward while playing; segments map `v` to real frames. A
 * seek resets the pipeline. A loop edit starts a new segment at the next
 * grain, which splices the input there (about two grains ahead of what is
 * audible) instead of resetting; a loop whose end is already behind the
 * audible position restarts at its start, like a seek.
 */
export declare class Transport {
    readonly stats: TransportStats;
    readonly frameCount: number;
    private readonly stretcher;
    private readonly channels;
    private readonly ring;
    private readonly mixLeft;
    private readonly mixRight;
    private readonly frameIndex;
    private segments;
    private loopRange;
    private trimBefore;
    private cursor;
    private primed;
    private playingState;
    private endedState;
    private speedValue;
    constructor(stretcher: BungeeStretcher, frameCount: number);
    setSource(id: string, source: StereoSource, state?: ChannelState): void;
    setChannel(id: string, state: ChannelState): void;
    removeSource(id: string): void;
    get playing(): boolean;
    get ended(): boolean;
    get speed(): number;
    set speed(value: number);
    get loop(): LoopRange | null;
    /** Source frame of the next frame render() will emit; the paused position while paused. */
    get position(): number;
    play(): void;
    pause(): void;
    /** Jumps to a source frame. The stretcher is flushed and re-primed, so the next output frame is the target. */
    seek(frame: number): void;
    /**
     * Sets or clears the loop without stopping. The change applies from the
     * next grain the stretcher analyses, so it is heard about two grains later.
     * A loop that starts ahead of the playhead is entered when playback reaches
     * it; one whose end is already behind the audible position restarts at its
     * start, like a seek.
     */
    setLoop(range: LoopRange | null): void;
    /**
     * Fills `frames` frames of stereo output and returns the source position of
     * the first emitted frame (NaN when none was: paused, ended, or starved).
     * `positions`, when given, receives the source position of every frame.
     */
    render(left: Float32Array, right: Float32Array, frames: number, positions?: Float64Array): number;
    /** Runs one grain through the stretcher and appends its output to the ring. Public for benchmarks. */
    produceGrain(): void;
    private flush;
    private normalizeLoop;
    private segmentAt;
    /** Real source frame for a timeline frame. */
    private realAt;
    /** Mixes every audible source into the stretcher's input for timeline frames [begin, end). */
    private fillInput;
}
