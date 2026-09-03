/**
 * Loads the standalone Bungee wasm module (native/bungee_web.cpp built with
 * -sSTANDALONE_WASM). There is no Emscripten JS glue: the handful of WASI
 * imports the module declares are stubbed here, so the same loader runs on the
 * main thread, in a worker, and inside an AudioWorkletGlobalScope.
 */

export interface BungeeExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  bw_version(): number;
  bw_create(inputRate: number, outputRate: number, channels: number, hopAdjust: number): number;
  bw_destroy(handle: number): void;
  bw_synthesis_hop(handle: number): number;
  bw_max_input_frames(handle: number): number;
  bw_input(handle: number): number;
  bw_input_stride(handle: number): number;
  bw_set_request(handle: number, position: number, speed: number, pitch: number, reset: number): void;
  bw_request_position(handle: number): number;
  bw_preroll(handle: number): void;
  bw_next(handle: number): void;
  bw_specify(handle: number): void;
  bw_chunk_begin(handle: number): number;
  bw_chunk_end(handle: number): number;
  bw_analyse(handle: number, muteHead: number, muteTail: number): void;
  bw_synthesise(handle: number): void;
  bw_output_data(handle: number): number;
  bw_output_frames(handle: number): number;
  bw_output_stride(handle: number): number;
  bw_output_begin(handle: number): number;
  bw_output_end(handle: number): number;
  bw_is_flushed(handle: number): number;
}

export type BungeeLogger = (line: string) => void;

/** Compiles the wasm bytes once; the Module is structured-cloneable, so it can be posted to a worklet. */
export async function compileBungee(source: BufferSource | Response | Promise<Response>): Promise<WebAssembly.Module> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return WebAssembly.compile(source);
  }
  const response = await source;
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      // Rejects before reading the body when the server did not say application/wasm.
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      // Fall through to the buffered path, which does not care about the MIME type.
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Instantiates a compiled module with WASI stubs and runs its static constructors. */
export async function instantiateBungee(
  module: WebAssembly.Module,
  log: BungeeLogger = (line) => console.info(`[bungee] ${line}`),
): Promise<BungeeExports> {
  const instance = await WebAssembly.instantiate(module, buildImports(module, () => exports, log));
  const exports = instance.exports as unknown as BungeeExports;
  exports._initialize?.();
  return exports;
}

/** Synchronous variant for scopes where `new WebAssembly.Instance` is allowed (workers, worklets). */
export function instantiateBungeeSync(module: WebAssembly.Module, log: BungeeLogger = () => {}): BungeeExports {
  const instance = new WebAssembly.Instance(module, buildImports(module, () => exports, log));
  const exports = instance.exports as unknown as BungeeExports;
  exports._initialize?.();
  return exports;
}

export function readCString(exports: BungeeExports, pointer: number): string {
  const bytes = new Uint8Array(exports.memory.buffer);
  let end = pointer;
  while (bytes[end] !== 0) end += 1;
  return decodeUtf8(bytes.subarray(pointer, end));
}

// AudioWorkletGlobalScope has no TextDecoder, so decode by hand.
function decodeUtf8(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    let code: number;
    if (b0 < 0x80) {
      code = b0;
      i += 1;
    } else if (b0 < 0xe0) {
      code = ((b0 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      i += 2;
    } else if (b0 < 0xf0) {
      code = ((b0 & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      i += 3;
    } else {
      code = ((b0 & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      i += 4;
    }
    text += String.fromCodePoint(code);
  }
  return text;
}

function buildImports(
  module: WebAssembly.Module,
  getExports: () => BungeeExports,
  log: BungeeLogger,
): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  let pending = '';

  const fdWrite = (_fd: number, iovs: number, iovsLength: number, writtenPointer: number): number => {
    const memory = getExports().memory.buffer;
    const view = new DataView(memory);
    let written = 0;
    for (let i = 0; i < iovsLength; i += 1) {
      const pointer = view.getUint32(iovs + i * 8, true);
      const length = view.getUint32(iovs + i * 8 + 4, true);
      pending += decodeUtf8(new Uint8Array(memory, pointer, length));
      written += length;
    }
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      log(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    view.setUint32(writtenPointer, written, true);
    return 0;
  };

  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') {
      throw new Error(`bungee.wasm imports unsupported ${entry.kind} ${entry.module}.${entry.name}`);
    }
    const target = (imports[entry.module] ??= {}) as Record<string, WebAssembly.ImportValue>;
    switch (entry.name) {
      case 'fd_write':
        target[entry.name] = fdWrite;
        break;
      case 'proc_exit':
        target[entry.name] = (code: number) => {
          throw new Error(`bungee.wasm exited with code ${code}`);
        };
        break;
      default:
        // fd_close, fd_seek, environ_*, clock_time_get and friends: report success and do nothing.
        target[entry.name] = () => 0;
    }
  }
  return imports;
}
