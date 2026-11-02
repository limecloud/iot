import { createContext, useContext } from "react";
import type { Call } from "./api";
import type { Session, Space } from "./contracts";
import type { Translator } from "./i18n";

export interface WorkspaceContext {
  session: Session;
  call: Call;
  t: Translator;
  locale: string;
  spaces?: Space[];
  space?: Space;
  href: (view?: string, values?: Record<string, string>) => string;
  navigate: (href: string) => void;
}
export const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("workspace_required");
  return value;
}
