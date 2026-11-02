import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, errorText, request, type Audience, type Call, type Session } from './api';

export function Auth({ audience, children }: { audience:Audience; children:(session:Session,call:Call,logout:()=>Promise<void>)=>ReactNode }) {
  const prefix=`/api/${audience}/v1/auth`, title=audience==='console'?'控制台':'管理后台';
  const [session,setSession]=useState<Session|null>(),[config,setConfig]=useState<{local:boolean;oidc:boolean}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>{let active=true;const abort=new AbortController();
    request<{local:boolean;oidc:boolean}>(`${prefix}/config`,undefined,undefined,abort.signal).then(v=>{if(active)setConfig(v)}).catch(e=>{if(active)setError(errorText(e))});
    request<Session>(`${prefix}/session`,undefined,undefined,abort.signal).then(v=>{if(active)setSession(v)}).catch(e=>{if(active){setSession(null);if(!(e instanceof ApiError&&e.status===401))setError(errorText(e))}});
    return()=>{active=false;abort.abort();generation.current++};
  },[prefix]);
  const call:Call=async(path,input,signal)=>{
    const current=generation.current;
    try{return await request(path,session??undefined,input,signal)}catch(e){if(e instanceof ApiError&&e.status===401&&generation.current===current){generation.current++;setSession(null);setError('会话已失效，请重新登录')}throw e}
  };
  async function login(event:React.FormEvent<HTMLFormElement>){event.preventDefault();if(busy)return;const form=event.currentTarget,token=String(new FormData(form).get('token')??'');setBusy(true);setError('');
    try{await request(`${prefix}/local`,undefined,{token});form.reset();const next=await request<Session>(`${prefix}/session`);generation.current++;setSession(next)}catch(e){setError(errorText(e))}finally{form.reset();setBusy(false)}
  }
  async function oidc(){if(busy)return;setBusy(true);setError('');try{const native=new URLSearchParams(location.search).get('native'),input=audience==='console'&&/^na-[a-f0-9]{64}$/.test(native??'')?{native_authorization:native}:{};const v=await request<{authorize_url:string}>(`${prefix}/start`,undefined,input);const url=new URL(v.authorize_url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw new Error();location.assign(url.href)}catch(e){setError(errorText(e));setBusy(false)}}
  async function logout(){if(busy)return;setBusy(true);setError('');try{await request(`${prefix}/logout`,session??undefined,{});generation.current++;setSession(null)}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  if(session)return <>{error&&<p role="alert" className="global-error">{error}</p>}<div key={session.csrf_token}>{children(session,call,logout)}</div></>;
  return <main className="entry"><a className="brand" href={`/${audience}/`}>LimeIoT</a><h1>{title}</h1>{session===undefined?<p role="status">正在恢复会话…</p>:<>{config?.oidc&&<button className="primary" disabled={busy} onClick={()=>void oidc()}>账号登录</button>}{config?.local&&<form onSubmit={event=>void login(event)}><label htmlFor="token">{audience==='console'?'所有者凭据':'管理员凭据'}</label><input autoComplete="off" id="token" name="token" type="password" required minLength={32} disabled={busy}/><button className="primary" disabled={busy}>{busy?'正在登录…':`登录${title}`}</button></form>}{!config&&<button onClick={()=>location.reload()}>重新连接</button>}</>}{error&&<p role="alert" className="notice">{error}</p>}</main>;
}
