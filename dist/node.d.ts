import type { PositionReport, SourceMessage, WorkletStats } from './protocol.ts';
import type { ChannelState, LoopRange } from './transport.ts';
export interface BungeeNodeReady {
    version: string;
    hop: number;
    sampleRate: number;
}
export type BungeeNodeEvents = {
    position: (report: PositionReport) => void;
    ended: (event: {
        position: number;
        contextTime: number;
    }) => void;
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
export declare class BungeeNode {
    readonly context: BaseAudioContext;
    readonly node: AudioWorkletNode;
    readonly ready: Promise<BungeeNodeReady>;
    private readonly listeners;
    private generation;
    private lastReport;
    private statsWaiters;
    private closed;
    static addModule(context: BaseAudioContext, workletUrl: string | URL): Promise<void>;
    constructor(context: BaseAudioContext, module: WebAssembly.Module);
    on<K extends keyof BungeeNodeEvents>(event: K, listener: BungeeNodeEvents[K]): () => void;
    /** True once `load()` has been called; transport commands before that throw. */
    get loaded(): boolean;
    /**
     * Hands the sources to the worklet, replacing any earlier set. A channel
     * that owns its whole ArrayBuffer is transferred (the caller's array goes
     * empty); a view onto a larger or shared buffer is copied first.
     */
    load(frameCount: number, sources: SourceMessage[]): void;
    addSource(source: SourceMessage): void;
    setChannel(id: string, state: ChannelState): void;
    removeSource(id: string): void;
    play(): void;
    pause(): void;
    seek(frame: number): void;
    setSpeed(speed: number): void;
    setLoop(range: LoopRange | null): void;
    stats(): Promise<WorkletStats>;
    /** The most recent report from the worklet, or null before the first load. */
    get report(): PositionReport | null;
    /**
     * Estimated source position now, extrapolated from the last report by the
     * context clock. Exact at report boundaries; between them it assumes the
     * reported speed held, which is what the worklet does too.
     */
    position(): number;
    /** Retires the processor, releasing the wasm heap and every source it holds. The node cannot be reused. */
    close(): void;
    /**
     * Updates the local report as if the worklet had already answered, so
     * position() reflects a command at once instead of one message round trip
     * later. The worklet's own report replaces it when it arrives.
     */
    private assume;
    private assertOpen;
    private assertLoaded;
    private failStats;
    private send;
    private receive;
}
