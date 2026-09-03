/// <reference types="@types/audioworklet" />
import type { WorkletCommand, WorkletEvent } from '../protocol.ts';
import { BungeeStretcher } from '../stretcher.ts';
import { Transport } from '../transport.ts';
import { instantiateBungeeSync } from '../wasm.ts';

const REPORT_EVERY = 8;

class BungeeProcessor extends AudioWorkletProcessor {
  private readonly stretcher: BungeeStretcher;
  private transport: Transport | null = null;
  private generation = 0;
  private renders = 0;
  private closed = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const module = options.processorOptions?.module as WebAssembly.Module | undefined;
    if (!module) throw new Error('bungee-transport needs processorOptions.module');
    const wasm = instantiateBungeeSync(module, (line) => this.post({ type: 'log', line }));
    this.stretcher = new BungeeStretcher(wasm, { sampleRate, channels: 2 });
    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
      try {
        this.handle(event.data);
      } catch (error) {
        this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    };
    this.post({ type: 'ready', version: BungeeStretcher.version(wasm), hop: this.stretcher.hop, sampleRate });
  }

  private post(event: WorkletEvent): void {
    this.port.postMessage(event);
  }

  private handle(command: WorkletCommand): void {
    if (this.closed) return;
    switch (command.type) {
      case 'load': {
        this.generation = command.generation;
        const transport = new Transport(this.stretcher, command.frameCount);
        this.transport = transport;
        for (const source of command.sources) this.addSource(source);
        this.report(transport);
        return;
      }
      case 'close':
        this.closed = true;
        this.transport = null;
        this.stretcher.destroy();
        this.port.close();
        return;
      case 'stats':
        this.postStats();
        return;
      default:
        break;
    }
    const transport = this.transport;
    if (!transport) return;
    switch (command.type) {
      case 'source':
        this.addSource(command.source);
        break;
      case 'channel':
        transport.setChannel(command.id, command.state);
        break;
      case 'remove':
        transport.removeSource(command.id);
        break;
      case 'play':
        transport.play();
        this.report(transport);
        break;
      case 'pause':
        transport.pause();
        this.report(transport);
        break;
      case 'seek':
        transport.seek(command.frame);
        this.report(transport);
        break;
      case 'speed':
        transport.speed = command.speed;
        this.report(transport);
        break;
      case 'loop':
        transport.setLoop(command.range);
        this.report(transport);
        break;
    }
  }

  private addSource(source: { id: string; left: Float32Array; right: Float32Array; gain?: number; pan?: number }): void {
    this.transport?.setSource(source.id, { left: source.left, right: source.right }, { gain: source.gain ?? 1, pan: source.pan ?? 0 });
  }

  private postStats(): void {
    const transport = this.transport;
    const empty = { grains: 0, renders: 0, maxGrainsPerRender: 0, trimmedFrames: 0, underruns: 0 };
    this.post({
      type: 'stats',
      generation: this.generation,
      stats: {
        ...(transport?.stats ?? empty),
        loaded: transport !== null,
        contextTime: currentTime,
        position: transport?.position ?? 0,
        playing: transport?.playing ?? false,
        ended: transport?.ended ?? false,
      },
    });
  }

  /** After a command: the next frame out, which the next quantum plays. */
  private report(transport: Transport): void {
    this.post({
      type: 'position',
      generation: this.generation,
      report: {
        position: transport.position,
        contextTime: currentTime + 128 / sampleRate,
        speed: transport.speed,
        playing: transport.playing,
      },
    });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
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
      this.post({ type: 'ended', generation: this.generation, position: transport.position, contextTime: currentTime });
    } else if (wasPlaying && this.renders % REPORT_EVERY === 0 && !Number.isNaN(first)) {
      this.post({
        type: 'position',
        generation: this.generation,
        report: { position: first, contextTime: currentTime, speed: transport.speed, playing: transport.playing },
      });
    }
    return true;
  }
}

registerProcessor('bungee-transport', BungeeProcessor);
