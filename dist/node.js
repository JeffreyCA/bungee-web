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
    context;
    node;
    ready;
    listeners = {
        position: new Set(),
        ended: new Set(),
        log: new Set(),
        error: new Set(),
    };
    generation = 0;
    lastReport = null;
    statsWaiters = [];
    closed = false;
    static addModule(context, workletUrl) {
        return context.audioWorklet.addModule(workletUrl);
    }
    constructor(context, module) {
        this.context = context;
        this.node = new AudioWorkletNode(context, 'bungee-transport', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { module },
        });
        this.ready = new Promise((resolve, reject) => {
            const onMessage = (event) => {
                const data = event.data;
                if (data.type === 'ready') {
                    resolve({ version: data.version, hop: data.hop, sampleRate: data.sampleRate });
                }
                else if (data.type === 'error') {
                    reject(new Error(data.message));
                }
            };
            this.node.port.addEventListener('message', onMessage, { once: true });
            this.node.onprocessorerror = () => {
                const message = 'bungee-transport processor failed; see the browser console';
                reject(new Error(message));
                this.failStats(new Error(message));
                for (const listener of this.listeners.error)
                    listener(message);
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
    load(frameCount, sources) {
        this.assertOpen();
        this.generation += 1;
        this.lastReport = null;
        const { sources: prepared, transfer } = prepareSources(sources);
        this.send({ type: 'load', generation: this.generation, frameCount, sources: prepared }, transfer);
    }
    addSource(source) {
        this.assertLoaded();
        const { sources, transfer } = prepareSources([source]);
        this.send({ type: 'source', source: sources[0] }, transfer);
    }
    setChannel(id, state) {
        this.assertLoaded();
        this.send({ type: 'channel', id, state });
    }
    removeSource(id) {
        this.assertLoaded();
        this.send({ type: 'remove', id });
    }
    play() {
        this.assertLoaded();
        this.send({ type: 'play' });
        this.assume({ playing: true });
    }
    pause() {
        this.assertLoaded();
        this.send({ type: 'pause' });
        this.assume({ playing: false });
    }
    seek(frame) {
        this.assertLoaded();
        this.send({ type: 'seek', frame });
        this.assume({ position: frame });
    }
    setSpeed(speed) {
        this.assertLoaded();
        this.send({ type: 'speed', speed });
        this.assume({ speed });
    }
    setLoop(range) {
        this.assertLoaded();
        this.send({ type: 'loop', range });
    }
    stats() {
        this.assertOpen();
        return new Promise((resolve, reject) => {
            this.statsWaiters.push({ resolve, reject });
            this.send({ type: 'stats' });
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
        if (!report)
            return 0;
        if (!report.playing)
            return report.position;
        const elapsed = this.context.currentTime - report.contextTime;
        return report.position + elapsed * this.context.sampleRate * report.speed;
    }
    /** Retires the processor, releasing the wasm heap and every source it holds. The node cannot be reused. */
    close() {
        if (this.closed)
            return;
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
    assume(change) {
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
    assertOpen() {
        if (this.closed)
            throw new Error('BungeeNode is closed');
    }
    assertLoaded() {
        this.assertOpen();
        if (!this.loaded)
            throw new Error('BungeeNode has no sources; call load() first');
    }
    failStats(error) {
        const waiters = this.statsWaiters;
        this.statsWaiters = [];
        for (const waiter of waiters)
            waiter.reject(error);
    }
    send(command, transfer = []) {
        this.node.port.postMessage(command, transfer);
    }
    receive(event) {
        switch (event.type) {
            case 'position':
                if (event.generation !== this.generation)
                    return;
                this.lastReport = event.report;
                for (const listener of this.listeners.position)
                    listener(event.report);
                break;
            case 'ended':
                if (event.generation !== this.generation)
                    return;
                this.lastReport = { position: event.position, contextTime: event.contextTime, speed: this.lastReport?.speed ?? 1, playing: false };
                for (const listener of this.listeners.ended)
                    listener(event);
                break;
            case 'stats': {
                const waiters = this.statsWaiters;
                this.statsWaiters = [];
                for (const waiter of waiters)
                    waiter.resolve(event.stats);
                break;
            }
            case 'log':
                for (const listener of this.listeners.log)
                    listener(event.line);
                break;
            case 'error':
                for (const listener of this.listeners.error)
                    listener(event.message);
                break;
            case 'ready':
                break;
        }
    }
}
/** Transfers channels that own their buffer, copies the rest, and never lists a buffer twice. */
function prepareSources(sources) {
    const transfer = new Set();
    const prepared = sources.map((source) => ({
        ...source,
        left: ownedChannel(source.left, transfer),
        right: ownedChannel(source.right, transfer),
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
