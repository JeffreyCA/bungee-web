// SPDX-License-Identifier: MIT
// C surface for the Bungee Basic granular API, compiled to standalone wasm.
//
// One Instance owns a stretcher, the request that names the current grain, the
// planar input buffer the host fills for that grain, and the last output chunk.
// The host (src/stretcher.ts) drives the same loop upstream's CLI does:
//   set request -> specify -> fill input -> analyse -> synthesise -> read output -> next

#include <bungee/Bungee.h>

#include <bit>
#include <cstdint>
#include <limits>
#include <vector>

#define BW_EXPORT extern "C" __attribute__((used, visibility("default")))

namespace {

struct Instance
{
	Bungee::Stretcher<Bungee::Basic> stretcher;
	Bungee::Request request{};
	Bungee::InputChunk chunk{};
	Bungee::OutputChunk output{};
	std::vector<float> input;
	int channelCount;
	int inputStride;
	int synthesisHop;

	Instance(int inputRate, int outputRate, int channels, int hopAdjust) :
		stretcher({inputRate, outputRate}, channels, hopAdjust),
		channelCount(channels),
		inputStride(stretcher.maxInputFrameCount()),
		synthesisHop(1 << (std::bit_width(unsigned(inputRate)) - 1 - 6 + hopAdjust))
	{
		input.assign(size_t(inputStride) * channels, 0.f);
		request.position = std::numeric_limits<double>::quiet_NaN();
		request.speed = 1.;
		request.pitch = 1.;
		request.reset = true;
		request.resampleMode = resampleMode_autoOut;
	}
};

} // namespace

BW_EXPORT const char *bw_version()
{
	return Bungee::Stretcher<Bungee::Basic>::version();
}

BW_EXPORT Instance *bw_create(int inputRate, int outputRate, int channels, int hopAdjust)
{
	return new Instance(inputRate, outputRate, channels, hopAdjust);
}

BW_EXPORT void bw_destroy(Instance *p)
{
	delete p;
}

BW_EXPORT int bw_synthesis_hop(const Instance *p)
{
	return p->synthesisHop;
}

BW_EXPORT int bw_max_input_frames(const Instance *p)
{
	return p->inputStride;
}

BW_EXPORT float *bw_input(Instance *p)
{
	return p->input.data();
}

BW_EXPORT int bw_input_stride(const Instance *p)
{
	return p->inputStride;
}

BW_EXPORT void bw_set_request(Instance *p, double position, double speed, double pitch, int reset)
{
	p->request.position = position;
	p->request.speed = speed;
	p->request.pitch = pitch;
	p->request.reset = reset != 0;
}

BW_EXPORT double bw_request_position(const Instance *p)
{
	return p->request.position;
}

BW_EXPORT void bw_preroll(Instance *p)
{
	p->stretcher.preroll(p->request);
}

BW_EXPORT void bw_next(Instance *p)
{
	p->stretcher.next(p->request);
}

// Specifies the grain named by the current request. The input chunk it needs
// is [bw_chunk_begin, bw_chunk_end) in source frames; the host copies that
// range into bw_input (frames past either end of the source stay unfilled and
// are declared through the mute counts of bw_analyse).
BW_EXPORT void bw_specify(Instance *p)
{
	p->chunk = p->stretcher.specifyGrain(p->request, 0.);
}

BW_EXPORT int bw_chunk_begin(const Instance *p)
{
	return p->chunk.begin;
}

BW_EXPORT int bw_chunk_end(const Instance *p)
{
	return p->chunk.end;
}

BW_EXPORT void bw_analyse(Instance *p, int muteHead, int muteTail)
{
	p->stretcher.analyseGrain(p->input.data(), p->inputStride, muteHead, muteTail);
}

BW_EXPORT void bw_synthesise(Instance *p)
{
	p->stretcher.synthesiseGrain(p->output);
}

BW_EXPORT float *bw_output_data(const Instance *p)
{
	return p->output.data;
}

BW_EXPORT int bw_output_frames(const Instance *p)
{
	return p->output.frameCount;
}

BW_EXPORT int bw_output_stride(const Instance *p)
{
	return int(p->output.channelStride);
}

// Source position of the first output frame, and of the frame after the last.
// NaN while the pipeline is still filling after a reset.
BW_EXPORT double bw_output_begin(const Instance *p)
{
	const auto *r = p->output.request[0];
	return r ? r->position : std::numeric_limits<double>::quiet_NaN();
}

BW_EXPORT double bw_output_end(const Instance *p)
{
	const auto *r = p->output.request[1];
	return r ? r->position : std::numeric_limits<double>::quiet_NaN();
}

BW_EXPORT int bw_is_flushed(const Instance *p)
{
	return p->stretcher.isFlushed() ? 1 : 0;
}
