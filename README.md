# bungee-web

Use [Bungee Basic](https://github.com/bungee-audio-stretch/bungee) in the browser for variable-speed audio playback without changing pitch. The package includes a WebAssembly build of Bungee, an `AudioWorklet` processor, and TypeScript APIs for real-time and offline rendering.

Listen to the [0.5x comparison](https://jeffreyca.github.io/bungee-web/) against Rubber Band R3 and ffmpeg's `atempo`.

## Install

```sh
npm install bungee-web
```

## Browser usage

Load the WebAssembly module and worklet once per `AudioContext`, then create a `BungeeNode` and give it one or more aligned stereo sources.

```ts
import { BungeeNode, compileBungee } from 'bungee-web';
import wasmUrl from 'bungee-web/bungee.wasm?url';
import workletUrl from 'bungee-web/worklet?url';

const context = new AudioContext();
const [module] = await Promise.all([
  compileBungee(fetch(wasmUrl)),
  BungeeNode.addModule(context, workletUrl),
]);
const node = new BungeeNode(context, module);
await node.ready;

// Planar Float32Arrays at the context's sample rate.
node.load(frameCount, [
  { id: 'vocals', left: vocalsL, right: vocalsR },
  { id: 'drums', left: drumsL, right: drumsR, gain: 0.8, pan: -0.2 },
]);
node.node.connect(context.destination);

node.setSpeed(0.75);
node.setLoop({ start: 3 * context.sampleRate, end: 5 * context.sampleRate });
node.play();

node.on('position', ({ position, contextTime }) => {
  // source frame that plays at contextTime
});
node.position(); // extrapolated from the last report

node.setChannel('drums', { gain: 0, pan: 0 });
node.seek(10 * context.sampleRate);
node.pause();
node.close();
```

The source arrays must use the `AudioContext` sample rate and have `frameCount` frames. Sources stay aligned and are mixed before stretching, so changing a stem's gain or pan does not create a separate stretcher.

`BungeeNode` supports playback, pause, seek, positive playback speeds, source-frame loops, live channel gain and pan changes, and position reports tied to `AudioContext.currentTime`. Pitch remains fixed at 1.0.

Calling `load()` transfers a channel's `ArrayBuffer` when the `Float32Array` owns the whole buffer. The original array becomes empty after the transfer. Views into shared or larger buffers are copied instead.

Call `close()` when the node is no longer needed. This retires the worklet processor and releases its sources and WebAssembly heap.

### Bundler setup

The `?url` imports in the example use Vite's asset URL syntax. With another bundler, configure the two package exports as assets and pass their public URLs to `fetch()` and `BungeeNode.addModule()`.

The published WebAssembly binary uses SIMD128. Browser playback also requires `AudioWorklet`.

## Offline and lower-level APIs

The main package exports three layers:

| API | Use |
| --- | --- |
| `BungeeNode` | Real-time playback through an `AudioWorkletNode` |
| `Transport` | Source mixing, playback state, loops, seeking, and offline rendering without Web Audio |
| `BungeeStretcher` | Direct access to Bungee's grain-based stretching interface |

`compileBungee`, `instantiateBungee`, and `instantiateBungeeSync` are also exported for applications that need to control where the module is compiled and instantiated.

See [`bench/render.ts`](bench/render.ts) for a Node.js offline-rendering example built with `Transport`.

## Behavior and limits

- Audio is stereo, planar `Float32Array` PCM.
- All sources in a `BungeeNode` share one frame count and sample rate.
- Speed must be finite and greater than zero. Independent pitch shifting is not exposed.
- Gain is linear and cannot be negative. Pan is clamped from `-1` to `1` and uses the Web Audio `StereoPannerNode` stereo law.
- Transport commands made before `load()` throw.
- At 1x speed, Bungee skips phase rotation. Output is close to the source, about -52 dB difference in the included benchmark, but is not bit-exact.

## Implementation

[`native/bungee_web.cpp`](native/bungee_web.cpp) wraps `Bungee::Stretcher<Basic>` in a C API and compiles it with Emscripten's standalone WebAssembly mode. The package does not use Emscripten's JavaScript glue. [`src/wasm.ts`](src/wasm.ts) supplies the small set of WASI imports needed to instantiate the same module on the main thread, in a worker, or inside an `AudioWorkletGlobalScope`.

The worklet stores source audio in JavaScript. For each grain, it mixes 4,096 input frames with the current gain and pan values, sends them through one Bungee stretcher, and receives 512 output frames tagged with their source positions.

Loops wrap the stretcher's forward-moving timeline onto a source range rather than resetting Bungee at each boundary. A loop edit takes effect at the next grain, roughly 25 ms after the audible position. Seeking flushes and primes the pipeline, then discards output before the requested source frame.

## Build from source

Building requires Node.js 24, CMake 3.30 or newer, Ninja, and Emscripten. On macOS, install the native tools with:

```sh
brew install emscripten ninja
```

Then install the JavaScript dependencies and build the package:

```bash
npm install
npm run build
```

The build writes the SIMD128 WebAssembly binary, JavaScript, declarations, and worklet bundle to `dist/`.

CMake fetches Bungee at a pinned commit with its Eigen and PFFFT submodules. The repository includes `dist/`, so installing from Git or a local path does not require Emscripten. Rebuild and commit `dist/` when source files change.

## Benchmarks

Render the included sample in Node.js and compare it with upstream Bungee's command-line program:

```sh
npm run build:native
npm run bench
```

Run the browser worklet test page with:

```sh
npm run bench:web
```

## License

The JavaScript and C++ code in this repository is MIT licensed. `dist/bungee.wasm` also contains unmodified Bungee Basic and Eigen code under MPL-2.0, plus PFFFT under its BSD-style license. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details.

Bungee Pro is a separate commercial product with its own web build. It is not part of this package.
