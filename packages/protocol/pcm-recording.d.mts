export const recordingLimits:{readonly sample_rate:16000;readonly channels:1;readonly bits_per_sample:16;readonly max_seconds:60;readonly max_frames:960000;readonly max_bytes:1920044};
export function encodeRecordedPcm(samples:Int16Array):Uint8Array<ArrayBuffer>;
