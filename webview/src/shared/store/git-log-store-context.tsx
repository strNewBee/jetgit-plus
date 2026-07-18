import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { PanelStore } from "./panel-store";

const GitLogStoreContext = createContext<StoreApi<PanelStore> | null>(null);

export function GitLogStoreProvider({
  children,
  store,
}: {
  children: ReactNode;
  store: StoreApi<PanelStore>;
}) {
  return (
    <GitLogStoreContext.Provider value={store}>
      {children}
    </GitLogStoreContext.Provider>
  );
}

export function useGitLogStore<T>(selector: (state: PanelStore) => T): T {
  const store = useContext(GitLogStoreContext);
  if (!store) {
    throw new Error("useGitLogStore must be used within GitLogStoreProvider");
  }
  return useStore(store, selector);
}
