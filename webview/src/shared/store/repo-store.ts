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
      // Fix-5 (F5): use the AUTHORITATIVE active id returned by the host (which
      // re-reads the registry after persist), NOT the requested `repoId`. The
      // host may legitimately resolve to a different repo (e.g. the requested
      // repo was selected but the descriptor id is normalized), and using the
      // requested id here would diverge from the host broadcast + persisted
      // state. The response carries the post-persist truth.
      const res = (await bridge.request(
        "selectRepo",
        { repoId },
        { scope: "global" },
      )) as { activeId: string | null } | null;
      const activeId = res?.activeId ?? null;
      bridge.setRepoContext(activeId);
      set({ activeRepoId: activeId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await bridge.request(
        "showErrorNotification",
        { message },
        { scope: "global" },
      );
      // The select failed — most commonly REPO_NOT_FOUND because the target was
      // removed by a concurrent folder reconciliation. Re-sync the WHOLE store
      // from the host so we converge onto the registry's fallback active repo
      // instead of being left on the stale requested `repoId`. (The host's
      // `activeRepoChanged` broadcast also drives convergence, but a lost race
      // where the broadcast already fired before this catch runs must not leave
      // the store wedged on an id the host no longer considers active.)
      await useRepoStore.getState().load();
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
