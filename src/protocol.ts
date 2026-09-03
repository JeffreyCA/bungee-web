import type { ChannelState, LoopRange, TransportStats } from './transport.ts';

/** A source handed to the worklet. `BungeeNode` transfers the buffers when it can and copies otherwise. */
export interface SourceMessage {
  id: string;
  left: Float32Array;
  right: Float32Array;
  gain?: number;
  pan?: number;
}

export type WorkletCommand =
  | { type: 'load'; generation: number; frameCount: number; sources: SourceMessage[] }
  | { type: 'source'; source: SourceMessage }
  | { type: 'channel'; id: string; state: ChannelState }
  | { type: 'remove'; id: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; frame: number }
  | { type: 'speed'; speed: number }
  | { type: 'loop'; range: LoopRange | null }
  | { type: 'stats' }
  | { type: 'close' };

export interface PositionReport {
  /** Source frame that plays at `contextTime`: the first frame of the quantum rendered then, or the paused position. */
  position: number;
  contextTime: number;
  speed: number;
  playing: boolean;
}

export interface WorkletStats extends TransportStats {
  loaded: boolean;
  contextTime: number;
  position: number;
  playing: boolean;
  ended: boolean;
}

/** Events carry the generation of the `load` they belong to, so a report from a replaced transport can be dropped. */
export type WorkletEvent =
  | { type: 'ready'; version: string; hop: number; sampleRate: number }
  | { type: 'position'; generation: number; report: PositionReport }
  | { type: 'ended'; generation: number; position: number; contextTime: number }
  | { type: 'stats'; generation: number; stats: WorkletStats }
  | { type: 'log'; line: string }
  | { type: 'error'; message: string };
