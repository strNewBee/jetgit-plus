import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bridge } from "../../shared/bridge";
import { usePanelStore } from "../../shared/store/panel-store";
import type { Commit } from "../../shared/types/git";

interface CommitContextMenuProps {
  x: number;
  y: number;
  commit: Commit;
  onClose: () => void;
}

export function CommitContextMenu({
  x,
  y,
  commit,
  onClose,
}: CommitContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const currentBranch = usePanelStore((s) => s.currentBranch);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // Adjust position after first render
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;

      let top = y;
      let left = x;

      if (top + rect.height > viewportH) {
        const above = y - rect.height;
        if (above >= 4) {
          top = above;
        } else {
          top = Math.max(4, viewportH - rect.height - 4);
        }
      }
      if (left + rect.width > viewportW) {
        left = Math.max(4, viewportW - rect.width - 4);
      }

      setPosition({ top, left });
    });
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleBlur = () => onClose();
    const handleScroll = (e: Event) => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleBlur);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleBlur);
    };
  }, [onClose]);

  const shortHash = commit.shortHash || commit.hash.slice(0, 8);

  const handleCopyHash = async () => {
    onClose();
    try {
      await bridge.request("copyToClipboard", { text: commit.hash });
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const handleCherryPick = async () => {
    onClose();
    try {
      await bridge.request("cherryPick", { hash: commit.hash });
    } catch (err) {
      console.error("Cherry-pick failed:", err);
    }
  };

  const handleCheckoutRevision = async () => {
    onClose();
    try {
      await bridge.request("checkoutCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Checkout revision failed:", err);
    }
  };

  const handleResetHard = async () => {
    onClose();
    const result = (await bridge.request("showConfirmMessage", {
      message: `Reset '${currentBranch}' to ${shortHash} (hard)? This will discard all uncommitted changes.`,
      confirmLabel: "Reset",
    })) as { confirmed: boolean };
    if (!result.confirmed) return;
    try {
      await bridge.request("resetToCommit", {
        hash: commit.hash,
        mode: "hard",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetMixed = async () => {
    onClose();
    try {
      await bridge.request("resetToCommit", {
        hash: commit.hash,
        mode: "mixed",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetSoft = async () => {
    onClose();
    try {
      await bridge.request("resetToCommit", {
        hash: commit.hash,
        mode: "soft",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleRevert = async () => {
    onClose();
    try {
      await bridge.request("revertCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Revert failed:", err);
    }
  };

  const handleNewBranch = async () => {
    onClose();
    const result = (await bridge.request("showInputBox", {
      prompt: `Create new branch from ${shortHash}:`,
      placeHolder: "branch-name",
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createBranchFromCommit", {
        branchName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create branch failed:", err);
    }
  };

  const handleNewTag = async () => {
    onClose();
    const result = (await bridge.request("showInputBox", {
      prompt: `Create tag at ${shortHash}:`,
      placeHolder: "tag-name",
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createTag", {
        tagName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create tag failed:", err);
    }
  };

  const items: {
    label: string;
    action: () => void;
    separator?: boolean;
  }[] = [
    { label: `Copy Revision Number`, action: handleCopyHash },
    { label: "Cherry-Pick", action: handleCherryPick },
    { label: "", action: () => {}, separator: true },
    { label: "Checkout Revision", action: handleCheckoutRevision },
    { label: "", action: () => {}, separator: true },
    {
      label: "Reset Current Branch to Here (Mixed)...",
      action: handleResetMixed,
    },
    {
      label: "Reset Current Branch to Here (Soft)...",
      action: handleResetSoft,
    },
    {
      label: "Reset Current Branch to Here (Hard)...",
      action: handleResetHard,
    },
    { label: "Revert Commit", action: handleRevert },
    { label: "", action: () => {}, separator: true },
    { label: "New Branch...", action: handleNewBranch },
    { label: "New Tag...", action: handleNewTag },
  ];

  const menu = (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: position ? position.top : -9999,
        left: position ? position.left : -9999,
        zIndex: 9999,
        background: "var(--vscode-menu-background, #252526)",
        border: "1px solid var(--vscode-menu-border, #454545)",
        borderRadius: 4,
        padding: "4px 0",
        minWidth: 200,
        maxHeight: "calc(100vh - 8px)",
        overflowY: "auto",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={`sep-${i}`}
            style={{
              height: 1,
              background: "var(--vscode-menu-separatorBackground, #454545)",
              margin: "4px 0",
            }}
          />
        ) : (
          <div
            key={item.label}
            onClick={item.action}
            style={{
              padding: "6px 16px",
              cursor: "pointer",
              color: "var(--vscode-menu-foreground, #ccc)",
              fontSize: "13px",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "var(--vscode-menu-selectionBackground, #094771)";
              (e.currentTarget as HTMLElement).style.color =
                "var(--vscode-menu-selectionForeground, #fff)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color =
                "var(--vscode-menu-foreground, #ccc)";
            }}
          >
            {item.label}
          </div>
        ),
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
