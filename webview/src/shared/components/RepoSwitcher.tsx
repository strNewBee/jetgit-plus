import { useCallback, useEffect, useRef, useState } from "react";
import CodiconChevronDown from "~icons/codicon/chevron-down";
import type { RepoDescriptorView } from "../store/repo-store";
import { useRepoStore } from "../store/repo-store";
import "./RepoSwitcher.css";

function pathHint(repo: RepoDescriptorView): string {
  const parts = repo.rootPath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return repo.rootPath;

  // A workspace folder commonly has the same leaf name as the repository.
  // In that case the parent is the useful disambiguator (for example
  // …/log-platform vs …/log-view), matching the compact JetBrains-style list.
  const leaf = parts.at(-1) ?? repo.rootPath;
  const context =
    leaf === repo.name && parts.length > 1 ? (parts.at(-2) ?? leaf) : leaf;
  return `…/${context}`;
}

export function RepoSwitcher({ disabled = false }: { disabled?: boolean }) {
  const { repos, activeRepoId, select } = useRepoStore();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setFilter("");
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (disabled || repos.length <= 1) close();
  }, [disabled, repos.length, close]);

  if (repos.length <= 1) return null;

  const active = repos.find((repo) => repo.id === activeRepoId);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredRepos = repos.filter((repo) => {
    if (!normalizedFilter) return true;
    return `${repo.name} ${repo.rootPath} ${pathHint(repo)}`
      .toLocaleLowerCase()
      .includes(normalizedFilter);
  });

  return (
    <div className="repo-switcher" ref={ref}>
      <span className="repo-switcher__label">Repo:</span>
      <div className="repo-switcher__control">
        <button
          ref={toggleRef}
          type="button"
          className="repo-switcher__trigger"
          disabled={disabled}
          title={
            disabled
              ? "Wait for loading or the current operation to finish"
              : active?.rootPath
          }
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Switch repository, current: ${active?.name ?? "none"}`}
          onClick={() => {
            if (open) close();
            else setOpen(true);
          }}
        >
          <span className="repo-switcher__current-name">
            {active?.name ?? "—"}
          </span>
          <CodiconChevronDown
            aria-hidden="true"
            className={`repo-switcher__chevron ${open ? "repo-switcher__chevron--open" : ""}`}
          />
        </button>

        {open && (
          <div className="repo-switcher__popover">
            <input
              ref={filterRef}
              className="repo-switcher__filter"
              type="text"
              value={filter}
              placeholder="Filter Repos..."
              aria-label="Filter repositories"
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
            <ul className="repo-switcher__list" role="listbox">
              {filteredRepos.map((repo) => {
                const hint = pathHint(repo);
                const activeRepo = repo.id === activeRepoId;
                return (
                  <li
                    key={repo.id}
                    className="repo-switcher__item"
                    role="option"
                    aria-selected={activeRepo}
                  >
                    <button
                      type="button"
                      className={`repo-switcher__option ${activeRepo ? "repo-switcher__option--active" : ""}`}
                      disabled={disabled}
                      title={repo.rootPath}
                      aria-label={`Select repository ${repo.name}, ${hint}`}
                      onClick={() => {
                        close();
                        if (!activeRepo) void select(repo.id);
                      }}
                    >
                      <span className="repo-switcher__repo-name">
                        {repo.name}
                      </span>
                      <span className="repo-switcher__repo-path">{hint}</span>
                    </button>
                  </li>
                );
              })}
              {filteredRepos.length === 0 && (
                <li className="repo-switcher__empty">No matching repos</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
