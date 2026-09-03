import { OutputRing } from './ring.ts';
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

interface Channel {
  source: StereoSource;
  gain: number;
  pan: number;
}

/**
 * One piece of the mapping from the stretcher's timeline to source frames:
 * for timeline frames at or after `v`, the source frame is `v + offset`
 * folded into `loop`. A loop edit appends a segment at the next grain, so
 * frames already analysed keep the mapping they were mixed with.
 */
interface Segment {
  v: number;
  offset: number;
  loop: LoopRange | null;
}

const MAX_GRAINS_PER_RENDER = 16;
const MIN_LOOP_FRAMES = 2;
const SEGMENT_HISTORY = 8;

function fold(x: number, loop: LoopRange | null): number {
  if (!loop || x < loop.end) return x;
  const length = loop.end - loop.start;
  return loop.start + ((x - loop.start) % length);
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}`);
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
export class Transport {
  readonly stats: TransportStats = { grains: 0, renders: 0, maxGrainsPerRender: 0, trimmedFrames: 0, underruns: 0 };
  readonly frameCount: number;
  private readonly stretcher: BungeeStretcher;
  private readonly channels = new Map<string, Channel>();
  private readonly ring: OutputRing;
  private readonly mixLeft: Float32Array;
  private readonly mixRight: Float32Array;
  private readonly frameIndex: Int32Array;
  private segments: Segment[] = [{ v: -Infinity, offset: 0, loop: null }];
  private loopRange: LoopRange | null = null;
  private trimBefore = -Infinity;
  private cursor = 0;
  private primed = false;
  private playingState = false;
  private endedState = false;
  private speedValue = 1;

  constructor(stretcher: BungeeStretcher, frameCount: number) {
    if (stretcher.channels !== 2) throw new Error(`Transport needs a stereo stretcher, got ${stretcher.channels} channels`);
    assertFinite(frameCount, 'frameCount');
    this.stretcher = stretcher;
    this.frameCount = Math.max(0, Math.floor(frameCount));
    this.ring = new OutputRing(stretcher.hop * 8);
    this.mixLeft = new Float32Array(stretcher.maxInputFrames);
    this.mixRight = new Float32Array(stretcher.maxInputFrames);
    this.frameIndex = new Int32Array(stretcher.maxInputFrames);
  }

  // --- sources ---------------------------------------------------------------

  setSource(id: string, source: StereoSource, state: ChannelState = { gain: 1, pan: 0 }): void {
    this.channels.set(id, { source, gain: 0, pan: 0 });
    this.setChannel(id, state);
  }

  setChannel(id: string, state: ChannelState): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.gain = Number.isFinite(state.gain) ? Math.max(0, state.gain) : 0;
    channel.pan = Number.isFinite(state.pan) ? Math.min(1, Math.max(-1, state.pan)) : 0;
  }

  removeSource(id: string): void {
    this.channels.delete(id);
  }

  // --- transport -------------------------------------------------------------

  get playing(): boolean {
    return this.playingState;
  }

  get ended(): boolean {
    return this.endedState;
  }

  get speed(): number {
    return this.speedValue;
  }

  set speed(value: number) {
    if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`speed must be positive, got ${value}`);
    this.speedValue = value;
  }

  get loop(): LoopRange | null {
    return this.loopRange;
  }

  /** Source frame of the next frame render() will emit; the paused position while paused. */
  get position(): number {
    return this.cursor;
  }

  play(): void {
    if (this.playingState) return;
    if (this.endedState || !this.primed) {
      this.seek(this.endedState ? this.loopRange?.start ?? 0 : this.cursor);
    }
    this.playingState = true;
  }

  pause(): void {
    this.playingState = false;
  }

  /** Jumps to a source frame. The stretcher is flushed and re-primed, so the next output frame is the target. */
  seek(frame: number): void {
    assertFinite(frame, 'seek frame');
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
  setLoop(range: LoopRange | null): void {
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
    // The next grain the stretcher specifies is centred on its request position;
    // from there on, map so the real frame continues from where the old mapping had it.
    const boundary = this.stretcher.requestPosition;
    const real = this.realAt(boundary);
    const segment: Segment = { v: boundary, offset: real - boundary, loop: next };
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
  render(left: Float32Array, right: Float32Array, frames: number, positions?: Float64Array): number {
    this.stats.renders += 1;
    if (!this.playingState) {
      left.fill(0, 0, frames);
      right.fill(0, 0, frames);
      positions?.fill(this.cursor, 0, frames);
      return NaN;
    }
    // Keep one frame beyond the quantum so `position` always names the next frame out.
    let grains = 0;
    while (this.ring.available < frames + 1 && grains < MAX_GRAINS_PER_RENDER) {
      this.produceGrain();
      grains += 1;
    }
    if (grains > this.stats.maxGrainsPerRender) this.stats.maxGrainsPerRender = grains;

    const available = Math.min(frames, this.ring.available);
    if (available < frames) this.stats.underruns += 1;

    // Stop at the end of the source when no loop wraps it.
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
      // The frame after the last emitted one is past the end: stop there.
      this.cursor = this.frameCount;
      this.playingState = false;
      this.endedState = true;
      this.ring.clear();
    } else if (this.ring.available > 0) {
      this.cursor = this.ring.positionAt(0);
    } else if (emit > 0) {
      // Starved: estimate the next frame from the last one out.
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
  produceGrain(): void {
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

  private flush(): void {
    const stretcher = this.stretcher;
    // Invalid (NaN) grains produce no audio and shift the old synthesis tail out.
    for (let i = 0; i < 4; i += 1) {
      stretcher.setRequest(NaN, this.speedValue, 1, false);
      stretcher.specify();
      stretcher.analyse(0, 0);
      stretcher.synthesise();
    }
  }

  private normalizeLoop(range: LoopRange): LoopRange {
    assertFinite(range.start, 'loop start');
    assertFinite(range.end, 'loop end');
    const start = Math.round(Math.min(Math.max(range.start, 0), this.frameCount));
    const end = Math.round(Math.min(Math.max(range.end, 0), this.frameCount));
    if (end - start < MIN_LOOP_FRAMES) throw new RangeError(`loop must span at least ${MIN_LOOP_FRAMES} frames`);
    return { start, end };
  }

  private segmentAt(v: number): Segment {
    const segments = this.segments;
    for (let i = segments.length - 1; i > 0; i -= 1) {
      if (v >= segments[i]!.v) return segments[i]!;
    }
    return segments[0]!;
  }

  /** Real source frame for a timeline frame. */
  private realAt(v: number): number {
    const segment = this.segmentAt(v);
    return fold(v + segment.offset, segment.loop);
  }

  /** Mixes every audible source into the stretcher's input for timeline frames [begin, end). */
  private fillInput(begin: number, end: number): { muteHead: number; muteTail: number } {
    const frames = end - begin;
    const index = this.frameIndex;
    const frameCount = this.frameCount;

    // Pass 1: the real frame behind every timeline frame, -1 where the source has none.
    let muteHead = 0;
    let muteTail = 0;
    let seenAudible = false;
    const segments = this.segments;
    for (let s = 0; s < segments.length; s += 1) {
      const segment = segments[s]!;
      const from = Math.max(begin, Math.ceil(segment.v));
      const to = Math.min(end, s + 1 < segments.length ? Math.ceil(segments[s + 1]!.v) : end);
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

    // Pass 2: accumulate each audible source with its pan law hoisted out of the frame loop.
    const left = this.mixLeft;
    const right = this.mixRight;
    left.fill(0, 0, frames);
    right.fill(0, 0, frames);
    for (const channel of this.channels.values()) {
      const { gain, pan } = channel;
      if (gain <= 0) continue;
      let leftFromLeft: number;
      let leftFromRight: number;
      let rightFromLeft: number;
      let rightFromRight: number;
      if (pan <= 0) {
        const x = ((pan + 1) * Math.PI) / 2;
        leftFromLeft = gain;
        leftFromRight = gain * Math.cos(x);
        rightFromLeft = 0;
        rightFromRight = gain * Math.sin(x);
      } else {
        const x = (pan * Math.PI) / 2;
        leftFromLeft = gain * Math.cos(x);
        leftFromRight = 0;
        rightFromLeft = gain * Math.sin(x);
        rightFromRight = gain;
      }
      const sourceLeft = channel.source.left;
      const sourceRight = channel.source.right;
      for (let i = 0; i < frames; i += 1) {
        const real = index[i]!;
        if (real < 0) continue;
        const l = sourceLeft[real] ?? 0;
        const r = sourceRight[real] ?? 0;
        left[i] = left[i]! + leftFromLeft * l + leftFromRight * r;
        right[i] = right[i]! + rightFromLeft * l + rightFromRight * r;
      }
    }

    this.stretcher.inputChannel(0).set(left.subarray(0, frames));
    this.stretcher.inputChannel(1).set(right.subarray(0, frames));
    return { muteHead, muteTail };
  }
}
