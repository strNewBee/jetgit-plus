import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRepoStore } from "../store/repo-store";
import { RepoSwitcher } from "./RepoSwitcher";

vi.mock("../bridge", () => ({
  bridge: {
    request: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    setRepoContext: vi.fn(),
  },
}));

afterEach(() => cleanup());

describe("RepoSwitcher", () => {
  it("renders nothing for 0 or 1 repos", () => {
    useRepoStore.setState({ repos: [], activeRepoId: null });
    const { container } = render(<RepoSwitcher />);
    expect(container.textContent).toBe("");
    useRepoStore.setState({
      repos: [{ id: "/a", name: "a", rootPath: "/a" }],
      activeRepoId: "/a",
    });
    const { container: c2 } = render(<RepoSwitcher />);
    expect(c2.textContent).toBe("");
  });

  it("renders for multiple repos", () => {
    useRepoStore.setState({
      repos: [
        { id: "/a", name: "a", rootPath: "/a" },
        { id: "/b", name: "b", rootPath: "/b" },
      ],
      activeRepoId: "/a",
    });
    const { getByText } = render(<RepoSwitcher />);
    expect(getByText(/a/)).toBeTruthy();
  });

  it("disables the toggle while an operation is in progress", () => {
    useRepoStore.setState({
      repos: [
        { id: "/a", name: "a", rootPath: "/a" },
        { id: "/b", name: "b", rootPath: "/b" },
      ],
      activeRepoId: "/a",
    });
    const { getByRole } = render(<RepoSwitcher disabled />);
    const toggle = getByRole("button", { name: /a/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});
