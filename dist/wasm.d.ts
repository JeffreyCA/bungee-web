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
export declare function compileBungee(source: BufferSource | Response | Promise<Response>): Promise<WebAssembly.Module>;
/** Instantiates a compiled module with WASI stubs and runs its static constructors. */
export declare function instantiateBungee(module: WebAssembly.Module, log?: BungeeLogger): Promise<BungeeExports>;
/** Synchronous variant for scopes where `new WebAssembly.Instance` is allowed (workers, worklets). */
export declare function instantiateBungeeSync(module: WebAssembly.Module, log?: BungeeLogger): BungeeExports;
export declare function readCString(exports: BungeeExports, pointer: number): string;
