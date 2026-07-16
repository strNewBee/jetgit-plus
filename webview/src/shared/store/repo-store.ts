import { create } from "zustand";
import { bridge } from "../bridge";

export interface RepoDescriptorView {
  id: string;
  name: string;
  rootPath: string;
}

interface RepoStore {
  repos: RepoDescriptorView[];
  activeRepoId: string | null;
  load: () => Promise<void>;
  select: (repoId: string) => Promise<void>;
}

export const useRepoStore = create<RepoStore>((set) => ({
  repos: [],
  activeRepoId: null,
  load: async () => {
    const data = (await bridge.request(
      "getRepos",
      {},
      { scope: "global" },
    )) as {
      repos: RepoDescriptorView[];
      activeId: string | null;
    };
    bridge.setRepoContext(data.activeId);
    set({ repos: data.repos, activeRepoId: data.activeId });
  },
  select: async (repoId) => {
    try {
      await bridge.request("selectRepo", { repoId }, { scope: "global" });
      bridge.setRepoContext(repoId);
      set({ activeRepoId: repoId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await bridge.request(
        "showErrorNotification",
        { message },
        { scope: "global" },
      );
    }
  },
}));

// Subscribe to backend-driven changes once.
let subscribed = false;
export function subscribeRepoEvents() {
  if (subscribed) return;
  subscribed = true;
  bridge.onEvent((event, data) => {
    if (event === "activeRepoChanged") {
      const repo = (data as { repo: RepoDescriptorView | null }).repo;
      const id = repo?.id ?? null;
      bridge.setRepoContext(id);
      useRepoStore.setState({ activeRepoId: id });
    } else if (event === "reposChanged") {
      const d = data as {
        repos: RepoDescriptorView[];
        activeId: string | null;
      };
      bridge.setRepoContext(d.activeId);
      useRepoStore.setState({ repos: d.repos, activeRepoId: d.activeId });
    }
  });
}
