import { useEffect, useRef, useState } from "react";
import { CommitList } from "./CommitList";
import { GitGraphSvg } from "./GitGraphSvg";

export function GitGraphPanel({
  onRefreshComparison,
}: {
  onRefreshComparison?: () => void | Promise<void>;
} = {}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [headerHeight, setHeaderHeight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(node);
    setContainerHeight(node.clientHeight);

    return () => ro.disconnect();
  }, []);

  const svgHeight = containerHeight - headerHeight;

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        minHeight: 0,
      }}
    >
      <CommitList
        onScroll={setScrollTop}
        onHeaderHeight={setHeaderHeight}
        onRefreshComparison={onRefreshComparison}
      />
      <GitGraphSvg
        scrollTop={scrollTop}
        height={svgHeight > 0 ? svgHeight : 0}
        topOffset={headerHeight}
      />
    </div>
  );
}
