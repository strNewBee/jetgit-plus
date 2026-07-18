import { Allotment } from "allotment";
import { useEffect, useMemo, useState } from "react";
import "allotment/dist/style.css";
import { bridge } from "../shared/bridge";
import {
  createGitLogStore,
  createRepoOperationProgressGroup,
  type GitLogStore,
} from "../shared/store/panel-store";
import type { GitRefIdentity, GitRefType } from "../shared/types/git";
import { CompareSurface } from "./CompareSurface";
import "./compare.css";

interface CompareSeed {
  repoId: string | null;
  selectedRef: GitRefIdentity | null;
  currentRef: GitRefIdentity | null;
}

interface ComparisonSession {
  top: GitLogStore;
  bottom: GitLogStore;
  refreshBoth: () => Promise<void>;
}

const gitRefTypes = new Set<GitRefType>(["local", "remote", "tag", "detached"]);

function readRef(
  dataset: DOMStringMap,
  prefix: "selected" | "current",
): GitRefIdentity | null {
  const type = dataset[`${prefix}RefType`];
  const name = dataset[`${prefix}RefName`];
  const fullRef = dataset[`${prefix}RefFullRef`];
  if (!type || !gitRefTypes.has(type as GitRefType) || !name || !fullRef) {
    return null;
  }
  return { type: type as GitRefType, name, fullRef };
}

function readSeed(): CompareSeed {
  const root = document.getElementById("root");
  const dataset = root?.dataset ?? {};
  return {
    repoId: dataset.repoId?.trim() || null,
    selectedRef: readRef(dataset, "selected"),
    currentRef: readRef(dataset, "current"),
  };
}

function AppState({
  state,
  children,
}: {
  state: "repository-unavailable" | "ref-unavailable" | "loading";
  children: React.ReactNode;
}) {
  return (
    <div
      className="compare-app-state"
      data-testid="compare-app-state"
      data-state={state}
    >
      {children}
    </div>
  );
}

export function CompareApp() {
  const seed = useMemo(readSeed, []);
  const [session, setSession] = useState<ComparisonSession | null>(null);

  useEffect(() => {
    if (!seed.repoId || !seed.selectedRef || !seed.currentRef) return;

    const operationProgressGroup = createRepoOperationProgressGroup();
    const top = createGitLogStore({
      repoId: seed.repoId,
      history: {
        kind: "comparison",
        revision: {
          kind: "range",
          excludeRef: seed.currentRef,
          includeRef: seed.selectedRef,
        },
      },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      operationProgressGroup,
      bridge,
    });
    const bottom = createGitLogStore({
      repoId: seed.repoId,
      history: {
        kind: "comparison",
        revision: {
          kind: "range",
          excludeRef: seed.selectedRef,
          includeRef: seed.currentRef,
        },
      },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      operationProgressGroup,
      bridge,
    });
    const refreshBoth = async () => {
      await Promise.all([
        top.store.getState().refresh({ preserveSelection: true }),
        bottom.store.getState().refresh({ preserveSelection: true }),
      ]);
    };
    const unsubscribe = bridge.onEvent((event) => {
      if (event === "comparePanelRefresh") void refreshBoth();
    });
    const nextSession = { top, bottom, refreshBoth };
    setSession(nextSession);
    void Promise.all([
      top.store.getState().fetchInitialData(),
      bottom.store.getState().fetchInitialData(),
    ]);

    return () => {
      unsubscribe();
      top.dispose();
      bottom.dispose();
    };
  }, [seed]);

  if (!seed.repoId) {
    return (
      <AppState state="repository-unavailable">
        Repository unavailable.
      </AppState>
    );
  }
  if (!seed.selectedRef || !seed.currentRef) {
    return <AppState state="ref-unavailable">Ref unavailable.</AppState>;
  }
  if (!session) return <AppState state="loading">Loading comparison…</AppState>;

  return (
    <main className="compare-app">
      <Allotment vertical proportionalLayout={false}>
        <Allotment.Pane minSize={180}>
          <CompareSurface
            id="top"
            store={session.top.store}
            fromRef={seed.currentRef}
            toRef={seed.selectedRef}
            onRefreshComparison={session.refreshBoth}
          />
        </Allotment.Pane>
        <Allotment.Pane minSize={180}>
          <CompareSurface
            id="bottom"
            store={session.bottom.store}
            fromRef={seed.selectedRef}
            toRef={seed.currentRef}
            onRefreshComparison={session.refreshBoth}
          />
        </Allotment.Pane>
      </Allotment>
    </main>
  );
}
