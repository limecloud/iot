import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { encodeRecordedPcm, recordingLimits } from '../packages/protocol/pcm-recording.mjs';
import { verifyPcmWav } from '../packages/protocol/media.mjs';

async function processor() {
  let Processor; const messages = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage(value) { messages.push(structuredClone(value)); } }; } }, registerProcessor(name, value) { assert.equal(name, 'limeiot-pcm-capture'); Processor = value; } });
  vm.runInContext(await readFile('apps/home/src/pcm-capture-worklet.js', 'utf8'), context);
  return { value: new Processor(), messages };
}

test('AudioWorklet的实际PCM转换、有界WAV及零扬声器写入', async () => {
  const { value, messages } = await processor();
  const output = new Float32Array(128); value.process([[new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])]], [[output]]);
  value.port.onmessage({ data: 'finish' }); const result = messages.find(value => value.type === 'complete');
  const pcm = new Int16Array(result.pcm); assert.deepEqual([...pcm], [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  assert.ok(output.every(value => value === 0)); const wav = encodeRecordedPcm(pcm);
  assert.deepEqual(verifyPcmWav(wav), { sample_rate: 16000, channels: 1, bits_per_sample: 16, frames: 7 });
  const bytes = new DataView(wav.buffer); assert.equal(bytes.getInt16(44, true), -32768); assert.equal(bytes.getInt16(56, true), 32767);
  assert.equal(value.process([[new Float32Array([1])]]), false); assert.equal(messages.filter(value => value.type === 'complete').length, 1);
});

test('60秒录音上限与取消、非有限采样均清除缓冲且不发布后续音频', async () => {
  const { value, messages } = await processor(); const block = new Float32Array(128).fill(0.25);
  for (let frames = 0; frames < recordingLimits.max_frames; frames += block.length) value.process([[block]]);
  const completed = messages.filter(value => value.type === 'complete'); assert.equal(completed.length, 1);
  const pcm = new Int16Array(completed[0].pcm); assert.equal(pcm.length, recordingLimits.max_frames); assert.ok(pcm.every(value => value === 8192));
  const wav = encodeRecordedPcm(pcm); assert.equal(wav.length, recordingLimits.max_bytes); assert.equal(verifyPcmWav(wav).frames, 16000 * 60);
  assert.equal(value.process([[block]]), false);
  for (const reason of ['cancel', 'invalid']) {
    const next = await processor(); next.value.process([[block]]);
    if (reason === 'cancel') next.value.port.onmessage({ data: 'cancel' }); else next.value.process([[new Float32Array([NaN])]]);
    next.value.port.onmessage({ data: 'finish' }); assert.equal(next.messages.some(value => value.type === 'complete'), false); assert.ok(next.value.samples.every(value => value === 0));
  }
  assert.throws(() => encodeRecordedPcm(new Int16Array()), /invalid_recording_audio/); assert.throws(() => encodeRecordedPcm(new Int16Array(960001)), /invalid_recording_audio/);
});
