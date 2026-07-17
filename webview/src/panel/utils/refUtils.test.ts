import { describe, expect, it } from "vitest";
import type {
  BranchInfo,
  GitRefIdentity,
  TagInfo,
} from "../../shared/types/git";
import {
  branchIdentity,
  compareFavoriteRefs,
  refKey,
  tagIdentity,
} from "./refUtils";

describe("refUtils", () => {
  it("keeps same-named local branches, remotes, and tags distinct", () => {
    const refs: GitRefIdentity[] = [
      { type: "local", name: "main", fullRef: "refs/heads/main" },
      { type: "remote", name: "main", fullRef: "refs/remotes/main" },
      { type: "tag", name: "main", fullRef: "refs/tags/main" },
    ];

    expect(new Set(refs.map(refKey)).size).toBe(3);
  });

  it("builds identities from branch and tag transport models", () => {
    expect(
      branchIdentity({
        name: "origin/main",
        fullRef: "refs/remotes/origin/main",
        isRemote: true,
      } as BranchInfo),
    ).toEqual({
      type: "remote",
      name: "origin/main",
      fullRef: "refs/remotes/origin/main",
    });
    expect(
      tagIdentity({ name: "v1", fullRef: "refs/tags/v1" } as TagInfo),
    ).toEqual({ type: "tag", name: "v1", fullRef: "refs/tags/v1" });
  });

  it("sorts favorites before current and alphabetical refs", () => {
    const refs = [
      { name: "z-current", isFavorite: false, isCurrent: true },
      { name: "b-favorite", isFavorite: true, isCurrent: false },
      { name: "a-favorite", isFavorite: true, isCurrent: false },
      { name: "a-normal", isFavorite: false, isCurrent: false },
    ];

    expect(refs.sort(compareFavoriteRefs).map((ref) => ref.name)).toEqual([
      "a-favorite",
      "b-favorite",
      "z-current",
      "a-normal",
    ]);
  });
});
