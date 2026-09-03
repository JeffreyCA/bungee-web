import { readFileSync, writeFileSync } from 'node:fs';

export interface Wav {
  sampleRate: number;
  channels: Float32Array[];
}

export function readWav(path: string): Wav {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { start: body, length: Math.min(length, bytes.length - body) };
    }
    offset = body + length + (length % 2);
  }
  if (!data || !channelCount) throw new Error(`${path}: missing fmt or data chunk`);
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const at = data.start + (frame * channelCount + channel) * bytesPerSample;
      let value: number;
      if (format === 3 && bits === 32) value = view.getFloat32(at, true);
      else if (format === 1 && bits === 16) value = view.getInt16(at, true) / 32768;
      else if (format === 1 && bits === 32) value = view.getInt32(at, true) / 2147483648;
      else if (format === 1 && bits === 24) {
        const raw = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
        value = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else throw new Error(`${path}: unsupported format ${format}/${bits}`);
      channels[channel]![frame] = value;
    }
  }
  return { sampleRate, channels };
}

export function writeWav(path: string, wav: Wav): void {
  const channelCount = wav.channels.length;
  const frames = wav.channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 4;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(wav.sampleRate, 24);
  buffer.writeUInt32LE(wav.sampleRate * channelCount * 4, 28);
  buffer.writeUInt16LE(channelCount * 4, 32);
  buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let at = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      buffer.writeFloatLE(wav.channels[channel]![frame] ?? 0, at);
      at += 4;
    }
  }
  writeFileSync(path, buffer);
}
