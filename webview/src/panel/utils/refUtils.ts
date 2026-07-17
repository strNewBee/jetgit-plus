import type {
  BranchInfo,
  GitRefIdentity,
  TagInfo,
} from "../../shared/types/git";

export function refKey(ref: GitRefIdentity): string {
  return `${ref.type}\0${ref.name}`;
}

export function branchIdentity(branch: BranchInfo): GitRefIdentity {
  return {
    type: branch.isRemote ? "remote" : "local",
    name: branch.name,
    fullRef: branch.fullRef,
  };
}

export function tagIdentity(tag: TagInfo): GitRefIdentity {
  return { type: "tag", name: tag.name, fullRef: tag.fullRef };
}

export function compareFavoriteRefs<
  T extends { name: string; isFavorite: boolean; isCurrent?: boolean },
>(a: T, b: T): number {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
  if (!!a.isCurrent !== !!b.isCurrent) return a.isCurrent ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
