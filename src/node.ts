import type { PositionReport, SourceMessage, WorkletCommand, WorkletEvent, WorkletStats } from './protocol.ts';
import type { ChannelState, LoopRange } from './transport.ts';

export interface BungeeNodeReady {
  version: string;
  hop: number;
  sampleRate: number;
}

export type BungeeNodeEvents = {
  position: (report: PositionReport) => void;
  ended: (event: { position: number; contextTime: number }) => void;
  log: (line: string) => void;
  error: (message: string) => void;
};

/**
 * Main-thread handle on the `bungee-transport` worklet: one node that plays
 * aligned stereo sources at variable speed with pitch held, in source time.
 *
 * Call `BungeeNode.addModule(context, workletUrl)` once per context, then
 * construct with a compiled wasm Module (see `compileBungee`), `load()` the
 * sources, and connect `node.node`. `close()` when done: a worklet node stays
 * alive, with everything it holds, until its processor retires.
 */
export class BungeeNode {
  readonly context: BaseAudioContext;
  readonly node: AudioWorkletNode;
  readonly ready: Promise<BungeeNodeReady>;
  private readonly listeners: { [K in keyof BungeeNodeEvents]: Set<BungeeNodeEvents[K]> } = {
    position: new Set(),
    ended: new Set(),
    log: new Set(),
    error: new Set(),
  };
  private generation = 0;
  private lastReport: PositionReport | null = null;
  private statsWaiters: Array<{ resolve: (stats: WorkletStats) => void; reject: (error: Error) => void }> = [];
  private closed = false;

  static addModule(context: BaseAudioContext, workletUrl: string | URL): Promise<void> {
    return context.audioWorklet.addModule(workletUrl);
  }

  constructor(context: BaseAudioContext, module: WebAssembly.Module) {
    this.context = context;
    this.node = new AudioWorkletNode(context, 'bungee-transport', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module },
    });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkletEvent>) => {
        const data = event.data;
        if (data.type === 'ready') {
          resolve({ version: data.version, hop: data.hop, sampleRate: data.sampleRate });
        } else if (data.type === 'error') {
          reject(new Error(data.message));
        }
      };
      this.node.port.addEventListener('message', onMessage, { once: true });
      this.node.onprocessorerror = () => {
        const message = 'bungee-transport processor failed; see the browser console';
        reject(new Error(message));
        this.failStats(new Error(message));
        for (const listener of this.listeners.error) listener(message);
      };
    });
    this.node.port.onmessage = (event: MessageEvent<WorkletEvent>) => this.receive(event.data);
  }

  on<K extends keyof BungeeNodeEvents>(event: K, listener: BungeeNodeEvents[K]): () => void {
    const set = this.listeners[event] as Set<BungeeNodeEvents[K]>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** True once `load()` has been called; transport commands before that throw. */
  get loaded(): boolean {
    return this.generation > 0;
  }

  /**
   * Hands the sources to the worklet, replacing any earlier set. A channel
   * that owns its whole ArrayBuffer is transferred (the caller's array goes
   * empty); a view onto a larger or shared buffer is copied first.
   */
  load(frameCount: number, sources: SourceMessage[]): void {
    this.assertOpen();
    this.generation += 1;
    this.lastReport = null;
    const { sources: prepared, transfer } = prepareSources(sources);
    this.send({ type: 'load', generation: this.generation, frameCount, sources: prepared }, transfer);
  }

  addSource(source: SourceMessage): void {
    this.assertLoaded();
    const { sources, transfer } = prepareSources([source]);
    this.send({ type: 'source', source: sources[0]! }, transfer);
  }

  setChannel(id: string, state: ChannelState): void {
    this.assertLoaded();
    this.send({ type: 'channel', id, state });
  }

  removeSource(id: string): void {
    this.assertLoaded();
    this.send({ type: 'remove', id });
  }

  play(): void {
    this.assertLoaded();
    this.send({ type: 'play' });
    this.assume({ playing: true });
  }

  pause(): void {
    this.assertLoaded();
    this.send({ type: 'pause' });
    this.assume({ playing: false });
  }

  seek(frame: number): void {
    this.assertLoaded();
    this.send({ type: 'seek', frame });
    this.assume({ position: frame });
  }

  setSpeed(speed: number): void {
    this.assertLoaded();
    this.send({ type: 'speed', speed });
    this.assume({ speed });
  }

  setLoop(range: LoopRange | null): void {
    this.assertLoaded();
    this.send({ type: 'loop', range });
  }

  stats(): Promise<WorkletStats> {
    this.assertOpen();
    return new Promise((resolve, reject) => {
      this.statsWaiters.push({ resolve, reject });
      this.send({ type: 'stats' });
    });
  }

  /** The most recent report from the worklet, or null before the first load. */
  get report(): PositionReport | null {
    return this.lastReport;
  }

  /**
   * Estimated source position now, extrapolated from the last report by the
   * context clock. Exact at report boundaries; between them it assumes the
   * reported speed held, which is what the worklet does too.
   */
  position(): number {
    const report = this.lastReport;
    if (!report) return 0;
    if (!report.playing) return report.position;
    const elapsed = this.context.currentTime - report.contextTime;
    return report.position + elapsed * this.context.sampleRate * report.speed;
  }

  /** Retires the processor, releasing the wasm heap and every source it holds. The node cannot be reused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: 'close' });
    this.node.disconnect();
    this.failStats(new Error('BungeeNode closed'));
  }

  /**
   * Updates the local report as if the worklet had already answered, so
   * position() reflects a command at once instead of one message round trip
   * later. The worklet's own report replaces it when it arrives.
   */
  private assume(change: Partial<PositionReport>): void {
    const position = this.position();
    const previous = this.lastReport;
    this.lastReport = {
      position,
      speed: previous?.speed ?? 1,
      playing: previous?.playing ?? false,
      ...change,
      contextTime: this.context.currentTime,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('BungeeNode is closed');
  }

  private assertLoaded(): void {
    this.assertOpen();
    if (!this.loaded) throw new Error('BungeeNode has no sources; call load() first');
  }

  private failStats(error: Error): void {
    const waiters = this.statsWaiters;
    this.statsWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private send(command: WorkletCommand, transfer: Transferable[] = []): void {
    this.node.port.postMessage(command, transfer);
  }

  private receive(event: WorkletEvent): void {
    switch (event.type) {
      case 'position':
        if (event.generation !== this.generation) return;
        this.lastReport = event.report;
        for (const listener of this.listeners.position) listener(event.report);
        break;
      case 'ended':
        if (event.generation !== this.generation) return;
        this.lastReport = { position: event.position, contextTime: event.contextTime, speed: this.lastReport?.speed ?? 1, playing: false };
        for (const listener of this.listeners.ended) listener(event);
        break;
      case 'stats': {
        const waiters = this.statsWaiters;
        this.statsWaiters = [];
        for (const waiter of waiters) waiter.resolve(event.stats);
        break;
      }
      case 'log':
        for (const listener of this.listeners.log) listener(event.line);
        break;
      case 'error':
        for (const listener of this.listeners.error) listener(event.message);
        break;
      case 'ready':
        break;
    }
  }
}

/** Transfers channels that own their buffer, copies the rest, and never lists a buffer twice. */
function prepareSources(sources: SourceMessage[]): { sources: SourceMessage[]; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const prepared = sources.map((source) => ({
    ...source,
    left: ownedChannel(source.left, transfer),
    right: ownedChannel(source.right, transfer),
  }));
  return { sources: prepared, transfer: [...transfer] };
}

function ownedChannel(channel: Float32Array, transfer: Set<ArrayBuffer>): Float32Array {
  const buffer = channel.buffer;
  const ownsWholeBuffer = buffer instanceof ArrayBuffer && channel.byteOffset === 0 && channel.byteLength === buffer.byteLength;
  if (ownsWholeBuffer && !transfer.has(buffer)) {
    transfer.add(buffer);
    return channel;
  }
  return channel.slice();
}
