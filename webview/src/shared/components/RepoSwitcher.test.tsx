import { cleanup, fireEvent, render } from "@testing-library/react";
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

const originalSelect = useRepoStore.getState().select;

afterEach(() => {
  cleanup();
  useRepoStore.setState({
    repos: [],
    activeRepoId: null,
    select: originalSelect,
  });
});

const duplicateRepos = [
  {
    id: "/workspace/log-platform/feat-alarm-receiver",
    name: "feat-alarm-receiver",
    rootPath: "/workspace/log-platform/feat-alarm-receiver",
  },
  {
    id: "/workspace/log-view/feat-alarm-receiver",
    name: "feat-alarm-receiver",
    rootPath: "/workspace/log-view/feat-alarm-receiver",
  },
];

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

  it("shows a compact Repo label and always-visible filter in the open popover", () => {
    useRepoStore.setState({
      repos: duplicateRepos,
      activeRepoId: duplicateRepos[0].id,
    });
    const { getByRole, getByText, getByPlaceholderText } = render(
      <RepoSwitcher />,
    );

    expect(getByText("Repo:")).toBeTruthy();
    const toggle = getByRole("button", {
      name: "Switch repository, current: feat-alarm-receiver",
    });
    expect(toggle.textContent).toContain("feat-alarm-receiver");
    expect(toggle.textContent).not.toContain("log-platform");

    fireEvent.click(toggle);

    expect(getByPlaceholderText("Filter Repos...")).toBeTruthy();
    expect(getByText("…/log-platform")).toBeTruthy();
    expect(getByText("…/log-view")).toBeTruthy();
  });

  it("filters repositories by their path hint", () => {
    useRepoStore.setState({
      repos: duplicateRepos,
      activeRepoId: duplicateRepos[0].id,
    });
    const { getByRole, getByPlaceholderText, getByText, queryByText } = render(
      <RepoSwitcher />,
    );

    fireEvent.click(
      getByRole("button", {
        name: "Switch repository, current: feat-alarm-receiver",
      }),
    );
    fireEvent.change(getByPlaceholderText("Filter Repos..."), {
      target: { value: "log-view" },
    });

    expect(queryByText("…/log-platform")).toBeNull();
    expect(getByText("…/log-view")).toBeTruthy();
  });

  it("closes on Escape and clears the previous filter", () => {
    useRepoStore.setState({
      repos: duplicateRepos,
      activeRepoId: duplicateRepos[0].id,
    });
    const { getByRole, getByPlaceholderText, queryByRole } = render(
      <RepoSwitcher />,
    );
    const toggle = getByRole("button", {
      name: "Switch repository, current: feat-alarm-receiver",
    });

    fireEvent.click(toggle);
    fireEvent.change(getByPlaceholderText("Filter Repos..."), {
      target: { value: "log-view" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();

    fireEvent.click(toggle);
    expect(
      (getByPlaceholderText("Filter Repos...") as HTMLInputElement).value,
    ).toBe("");
  });

  it("selects a repository and closes the popover", () => {
    const select = vi.fn(async () => {});
    useRepoStore.setState({
      repos: duplicateRepos,
      activeRepoId: duplicateRepos[0].id,
      select,
    });
    const { getByRole, queryByRole } = render(<RepoSwitcher />);

    fireEvent.click(
      getByRole("button", {
        name: "Switch repository, current: feat-alarm-receiver",
      }),
    );
    fireEvent.click(
      getByRole("button", {
        name: "Select repository feat-alarm-receiver, …/log-view",
      }),
    );

    expect(select).toHaveBeenCalledWith(duplicateRepos[1].id);
    expect(queryByRole("listbox")).toBeNull();
  });
});
