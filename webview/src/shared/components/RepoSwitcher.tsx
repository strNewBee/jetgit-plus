import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "../store/repo-store";

export function RepoSwitcher({ disabled = false }: { disabled?: boolean }) {
  const { repos, activeRepoId, select } = useRepoStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (repos.length <= 1) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [repos.length]);

  if (repos.length <= 1) return null; // single repo: no switcher

  const active = repos.find((r) => r.id === activeRepoId);
  const nameCounts = new Map<string, number>();
  for (const r of repos)
    nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  const label = (r: { name: string; rootPath: string }) => {
    if ((nameCounts.get(r.name) ?? 0) <= 1) return r.name;
    const shortPath = r.rootPath
      .split(/[\\/]/)
      .filter(Boolean)
      .slice(-2)
      .join("/");
    return `${r.name} (${shortPath})`;
  };

  return (
    <div className="repo-switcher" ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        title={
          disabled
            ? "Wait for loading or the current operation to finish"
            : undefined
        }
        onClick={() => setOpen((v) => !v)}
      >
        {active ? label(active) : "—"} ▾
      </button>
      {open && (
        <ul
          style={{
            position: "absolute",
            zIndex: 10,
            listStyle: "none",
            margin: 0,
            padding: 0,
            background: "var(--bg)",
            border: "1px solid var(--border)",
          }}
        >
          {repos.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  if (r.id !== activeRepoId) void select(r.id);
                }}
                style={{
                  fontWeight: r.id === activeRepoId ? "bold" : "normal",
                }}
              >
                {label(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
