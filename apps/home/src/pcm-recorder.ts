import { encodeRecordedPcm, recordingLimits } from '../../../packages/protocol/pcm-recording.mjs';
import captureModule from './pcm-capture-worklet.js?url&no-inline';

type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'finishing';
type Options = { active: () => boolean; onState: (phase: RecorderPhase, seconds: number) => void; onComplete: (file: File) => void; onError: (code: string) => void };

export class PcmRecorder {
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phase: RecorderPhase = 'idle';
  private seconds = 0;
  constructor(private options: Options) {}
  private current(generation: number) { return generation === this.generation && this.options.active(); }
  private state(phase: RecorderPhase) { this.phase = phase; this.options.onState(phase, this.seconds); }
  private release() {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.onmute = null; track.stop(); }
    this.stream = null;
    if (this.node) { this.node.port.onmessage = null; this.node.onprocessorerror = null; this.node.port.postMessage('cancel'); this.node.disconnect(); this.node.port.close(); }
    this.source?.disconnect(); this.source = null; this.node = null;
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); this.context = null; }
  }
  cancel() { this.generation++; this.release(); this.seconds = 0; this.state('idle'); }
  private fail(code: string) { this.cancel(); this.options.onError(code); }
  async start() {
    if (this.phase !== 'idle') return;
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) { this.options.onError('recording_not_supported'); return; }
    const generation = ++this.generation; this.seconds = 0; this.state('requesting');
    this.timer = setTimeout(() => { if (this.current(generation)) this.fail('recording_permission_timeout'); }, 30000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!this.current(generation)) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (stream.getAudioTracks().length !== 1 || stream.getVideoTracks().length !== 0 || stream.getAudioTracks()[0].readyState !== 'live') throw new Error('recording_device_unavailable');
      const context = new AudioContext({ sampleRate: recordingLimits.sample_rate }); this.context = context;
      if (context.sampleRate !== recordingLimits.sample_rate || !context.audioWorklet) throw new Error('recording_not_supported');
      await context.audioWorklet.addModule(captureModule);
      if (!this.current(generation)) return;
      const node = new AudioWorkletNode(context, 'limeiot-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      this.node = node; node.connect(context.destination);
      node.onprocessorerror = () => { if (this.current(generation)) this.fail('recording_failed'); };
      node.port.onmessage = event => {
        if (!this.current(generation)) return;
        if (event.data?.type === 'progress') { this.seconds = event.data.seconds; this.options.onState(this.phase, this.seconds); }
        else if (event.data?.type === 'error') this.fail('recording_failed');
        else if (event.data?.type === 'complete') {
          try {
            if (!(event.data.pcm instanceof ArrayBuffer)) throw new Error();
            const samples = new Int16Array(event.data.pcm); const bytes = encodeRecordedPcm(samples); samples.fill(0);
            const file = new File([bytes], 'recording.wav', { type: 'audio/wav' });
            this.generation++; this.release(); this.seconds = 0; this.state('idle');
            if (this.options.active()) this.options.onComplete(file);
          } catch { this.fail('recording_failed'); }
        }
      };
      this.source = context.createMediaStreamSource(stream); this.source.connect(node);
      const interrupted = () => { if (this.current(generation)) this.fail('recording_interrupted'); };
      stream.getAudioTracks()[0].onended = interrupted; stream.getAudioTracks()[0].onmute = interrupted;
      context.onstatechange = () => { if (this.current(generation) && this.phase === 'recording' && context.state !== 'running') interrupted(); };
      await context.resume(); if (!this.current(generation)) return;
      if (context.state !== 'running') throw new Error('recording_interrupted');
      if (this.timer !== null) clearTimeout(this.timer);
      this.state('recording'); this.timer = setTimeout(() => { if (this.current(generation)) this.finish(); }, recordingLimits.max_seconds * 1000);
    } catch (error) {
      if (!this.current(generation)) return;
      const code = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'recording_permission_denied' : error instanceof DOMException && ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name) ? 'recording_device_unavailable' : error instanceof Error && ['recording_not_supported', 'recording_interrupted', 'recording_device_unavailable'].includes(error.message) ? error.message : 'recording_failed';
      this.fail(code);
    }
  }
  finish() {
    if (this.phase !== 'recording' || !this.node) return;
    if (!this.options.active()) { this.cancel(); return; }
    if (this.timer !== null) clearTimeout(this.timer);
    this.state('finishing'); this.node.port.postMessage('finish');
    this.timer = setTimeout(() => this.fail('recording_failed'), 3000);
  }
}
