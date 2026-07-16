import type { GitService } from "./gitService";

export interface RepoDescriptor {
  id: string;
  name: string;
  rootPath: string;
}

/**
 * Disambiguated repo label for display. Returns `target.name` when that name is
 * unique across `all`, else `${target.name} (${shortPath})` where `shortPath` is
 * the last 2 segments of `target.rootPath` split on `[\\/]` — exactly mirroring
 * RepoSwitcher's (webview/src/shared/components/RepoSwitcher.tsx) disambiguation
 * so every surface shows the same string for the same repo.
 *
 * The label is computed at call time (open/reveal) from the CURRENT registry
 * list, so it stays correct as repos are added/removed. Used by the operation
 * panels (Push/Rollback/Conflicts) to show which repo they act on (Task 25).
 */
export function formatRepoLabel(
  target: Pick<RepoDescriptor, "name" | "rootPath">,
  all: Pick<RepoDescriptor, "name">[],
): string {
  const nameCount = all.filter((r) => r.name === target.name).length;
  if (nameCount <= 1) return target.name;
  const shortPath = target.rootPath
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join("/");
  return `${target.name} (${shortPath})`;
}

export interface RepositoryPaths {
  workTreeRoot: string;
  gitDir: string;
  commonDir: string;
}

export interface DiscoveredRepo {
  descriptor: RepoDescriptor;
  paths: RepositoryPaths;
}

export interface RepoRuntime extends DiscoveredRepo {
  gitService: GitService;
}

export class RepoRegistry {
  private runtimes = new Map<string, RepoRuntime>();
  private order: string[] = [];
  private activeId: string | null = null;

  build(
    repos: DiscoveredRepo[],
    factory: (paths: RepositoryPaths) => GitService,
  ): void {
    this.runtimes.clear();
    this.order = [];
    this.activeId = null;
    for (const repo of repos) this.add(repo, factory(repo.paths));
  }

  add(repo: DiscoveredRepo, gitService: GitService): RepoRuntime {
    const existing = this.runtimes.get(repo.descriptor.id);
    if (existing) return existing;
    const runtime: RepoRuntime = {
      ...repo,
      gitService,
    };
    this.runtimes.set(repo.descriptor.id, runtime);
    this.order.push(repo.descriptor.id);
    this.activeId ??= repo.descriptor.id;
    return runtime;
  }

  remove(id: string): RepoRuntime | undefined {
    const runtime = this.runtimes.get(id);
    if (!runtime) return undefined;
    this.runtimes.delete(id);
    this.order = this.order.filter((entry) => entry !== id);
    if (this.activeId === id) this.activeId = this.order[0] ?? null;
    return runtime;
  }

  list(): RepoDescriptor[] {
    const descriptors: RepoDescriptor[] = [];
    for (const id of this.order) {
      const runtime = this.runtimes.get(id);
      if (runtime) descriptors.push(runtime.descriptor);
    }
    return descriptors;
  }

  get(id: string): RepoRuntime | undefined {
    return this.runtimes.get(id);
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getActive(): RepoRuntime | null {
    return this.activeId ? (this.runtimes.get(this.activeId) ?? null) : null;
  }

  setActive(id: string): boolean {
    if (!this.runtimes.has(id)) return false;
    this.activeId = id;
    return true;
  }

  get size(): number {
    return this.order.length;
  }
}
