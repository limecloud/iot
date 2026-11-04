/* 本机采音只在有界内存保存PCM，不输出到扬声器或网络。 */
class LimePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(960000); this.frames = 0; this.seconds = 0; this.done = false;
    this.port.onmessage = event => {
      if (event.data === 'finish') this.finish();
      if (event.data === 'cancel') { this.done = true; this.samples.fill(0); this.frames = 0; }
    };
  }
  finish() {
    if (this.done) return;
    this.done = true; const pcm = this.samples.slice(0, this.frames); this.samples.fill(0);
    this.port.postMessage({ type: 'complete', pcm: pcm.buffer }, [pcm.buffer]);
  }
  process(inputs) {
    if (this.done) return false;
    const input = inputs[0]?.[0]; if (!input) return true;
    for (const sample of input) {
      if (!Number.isFinite(sample)) { this.done = true; this.samples.fill(0); this.port.postMessage({ type: 'error' }); return false; }
      const value = Math.max(-1, Math.min(1, sample));
      this.samples[this.frames++] = Math.round(value < 0 ? value * 32768 : value * 32767);
      if (this.frames === this.samples.length) { this.finish(); return false; }
    }
    const seconds = Math.floor(this.frames / 16000);
    if (seconds !== this.seconds) { this.seconds = seconds; this.port.postMessage({ type: 'progress', seconds }); }
    return true;
  }
}
registerProcessor('limeiot-pcm-capture', LimePcmCapture);
