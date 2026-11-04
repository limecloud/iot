import { verifyPcmWav } from './media.mjs';

export const recordingLimits = Object.freeze({ sample_rate: 16000, channels: 1, bits_per_sample: 16, max_seconds: 60, max_frames: 960000, max_bytes: 1920044 });

export function encodeRecordedPcm(samples) {
  if (!(samples instanceof Int16Array) || samples.length < 1 || samples.length > recordingLimits.max_frames) throw new Error('invalid_recording_audio');
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, recordingLimits.sample_rate, true); view.setUint32(28, recordingLimits.sample_rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  verifyPcmWav(bytes); return bytes;
}
