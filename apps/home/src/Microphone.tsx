import { useEffect, useRef, useState } from 'react';
import { PcmRecorder } from './pcm-recorder';

const messages: Record<string, string> = { recording_not_supported: '当前浏览器不支持录音，请使用 HTTPS 或选择 WAV 文件', recording_permission_denied: '未获得麦克风权限，可在浏览器设置中允许', recording_permission_timeout: '等待麦克风授权超时，请重新开始', recording_device_unavailable: '麦克风不可用，请检查设备', recording_interrupted: '录音已中断，请重新开始', recording_failed: '未能保存录音，请重新开始' };
export function Microphone({ available, disabled, onRecorded, onClear, onCaptureChange }: { available: boolean; disabled: boolean; onRecorded: (file: File) => void; onClear: () => void; onCaptureChange: (active: boolean) => void }) {
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'finishing'>('idle'), [seconds, setSeconds] = useState(0), [message, setMessage] = useState('');
  const mounted = useRef(false), enabled = useRef(available), recorder = useRef<PcmRecorder | null>(null), recorded = useRef(onRecorded), clear = useRef(onClear), changed = useRef(onCaptureChange);
  enabled.current = available; recorded.current = onRecorded; clear.current = onClear; changed.current = onCaptureChange;
  useEffect(() => {
    mounted.current = true;
    recorder.current = new PcmRecorder({ active: () => mounted.current && enabled.current && !document.hidden, onState: (next, elapsed) => { if (mounted.current) { setPhase(next); setSeconds(elapsed); changed.current(next !== 'idle'); } }, onComplete: file => recorded.current(file), onError: code => { if (mounted.current) setMessage(messages[code] ?? messages.recording_failed); } });
    const cancel = () => { recorder.current?.cancel(); clear.current(); };
    const visibility = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', visibility); addEventListener('pagehide', cancel);
    return () => { mounted.current = false; recorder.current?.cancel(); recorder.current = null; clear.current(); document.removeEventListener('visibilitychange', visibility); removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (!available) { recorder.current?.cancel(); clear.current(); } }, [available]);
  return <div className="microphone" role="group" aria-label="麦克风录音"><div className="actions">
    {phase === 'idle' ? <button type="button" disabled={disabled} onClick={() => { setMessage(''); clear.current(); void recorder.current?.start(); }}>开始录音</button> : <>
      {phase === 'recording' && <button type="button" onClick={() => recorder.current?.finish()}>完成录音</button>}
      <button type="button" onClick={() => { recorder.current?.cancel(); clear.current(); setMessage(''); }}>取消录音</button>
    </>}
    <span role="status">{phase === 'requesting' ? '等待麦克风授权' : phase === 'recording' ? `正在录音 ${seconds} / 60 秒` : phase === 'finishing' ? '正在保存录音' : ''}</span>
  </div>{message && <p className="notice" role="status">{message}</p>}</div>;
}
