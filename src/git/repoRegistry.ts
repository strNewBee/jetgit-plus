import type { GitService } from "./gitService";

export interface RepoDescriptor {
  id: string;
  name: string;
  rootPath: string;
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
