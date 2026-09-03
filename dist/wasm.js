/**
 * Loads the standalone Bungee wasm module (native/bungee_web.cpp built with
 * -sSTANDALONE_WASM). There is no Emscripten JS glue: the handful of WASI
 * imports the module declares are stubbed here, so the same loader runs on the
 * main thread, in a worker, and inside an AudioWorkletGlobalScope.
 */
/** Compiles the wasm bytes once; the Module is structured-cloneable, so it can be posted to a worklet. */
export async function compileBungee(source) {
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        return WebAssembly.compile(source);
    }
    const response = await source;
    if (typeof WebAssembly.compileStreaming === 'function') {
        try {
            // Rejects before reading the body when the server did not say application/wasm.
            return await WebAssembly.compileStreaming(response.clone());
        }
        catch {
            // Fall through to the buffered path, which does not care about the MIME type.
        }
    }
    return WebAssembly.compile(await response.arrayBuffer());
}
/** Instantiates a compiled module with WASI stubs and runs its static constructors. */
export async function instantiateBungee(module, log = (line) => console.info(`[bungee] ${line}`)) {
    const instance = await WebAssembly.instantiate(module, buildImports(module, () => exports, log));
    const exports = instance.exports;
    exports._initialize?.();
    return exports;
}
/** Synchronous variant for scopes where `new WebAssembly.Instance` is allowed (workers, worklets). */
export function instantiateBungeeSync(module, log = () => { }) {
    const instance = new WebAssembly.Instance(module, buildImports(module, () => exports, log));
    const exports = instance.exports;
    exports._initialize?.();
    return exports;
}
export function readCString(exports, pointer) {
    const bytes = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (bytes[end] !== 0)
        end += 1;
    return decodeUtf8(bytes.subarray(pointer, end));
}
// AudioWorkletGlobalScope has no TextDecoder, so decode by hand.
function decodeUtf8(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length;) {
        const b0 = bytes[i];
        let code;
        if (b0 < 0x80) {
            code = b0;
            i += 1;
        }
        else if (b0 < 0xe0) {
            code = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
            i += 2;
        }
        else if (b0 < 0xf0) {
            code = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
            i += 3;
        }
        else {
            code = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
            i += 4;
        }
        text += String.fromCodePoint(code);
    }
    return text;
}
function buildImports(module, getExports, log) {
    const imports = {};
    let pending = '';
    const fdWrite = (_fd, iovs, iovsLength, writtenPointer) => {
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
        const target = (imports[entry.module] ??= {});
        switch (entry.name) {
            case 'fd_write':
                target[entry.name] = fdWrite;
                break;
            case 'proc_exit':
                target[entry.name] = (code) => {
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
