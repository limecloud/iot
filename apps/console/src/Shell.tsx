import type { Session } from '@limeiot/control-ui/api.ts';

export function ConsoleHeader({session,logout}:{session:Session;logout:()=>Promise<void>}) {
  return <header className="bar"><a className="brand" href="/console/">LimeIoT</a><span className="muted">控制台</span><div className="account"><span className="small muted">{session.principal.name}</span><button onClick={()=>void logout()}>退出登录</button></div></header>;
}
export function WorkspaceNav({products=false}:{products?:boolean}) {
  return <nav className="tabs" aria-label="控制台任务"><a href="/console/" aria-current={!products?'page':undefined}>空间</a><a href="/console/?view=products" aria-current={products?'page':undefined}>产品</a></nav>;
}
