/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import {
  getIssueSurfaceViewStore,
  pruneIssueSurfaceViewStates,
} from "@multica/core/issues/stores/surface-view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { IssueStatusDefinition } from "@multica/core/types";
import { useIssueSurfaceController } from "./use-issue-surface-controller";

// MUL-4809 — UUID status selection must still fetch server status branches.
//
// The filter menu writes a CATALOG ID for built-in statuses too. The List /
// status-grouped Board derive their server branches from the selection, and
// that derivation used to test the raw selection against the 7 legacy tokens:
// a UUID matches none of them, so zero branches were requested and the surface
// rendered empty for every status a user picked. Only a stale localStorage
// selection (legacy tokens) still worked.

const TODO_ID = "11111111-1111-4111-8111-111111111111";
const NEEDS_QA_ID = "22222222-2222-4222-8222-222222222222";

function status(
  overrides: Partial<IssueStatusDefinition> &
    Pick<IssueStatusDefinition, "id" | "name" | "category">,
): IssueStatusDefinition {
  return {
    workspace_id: "ws-1",
    description: "",
    icon: overrides.category,
    color: "info",
    system_key: null,
    is_system: false,
    is_default: false,
    position: 1,
    archived: false,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const CATALOG: IssueStatusDefinition[] = [
  status({
    id: TODO_ID,
    name: "Todo",
    category: "todo",
    system_key: "todo",
    is_system: true,
    is_default: true,
  }),
  // A CUSTOM status: no system_key, so it projects to its Category lane.
  status({ id: NEEDS_QA_ID, name: "Needs QA", category: "in_progress" }),
];

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutate: vi.fn(), isPending: false }),
  useBatchUpdateIssues: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBatchDeleteIssues: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ open: vi.fn() }) },
}));
vi.mock("../../i18n", () => ({
  useT: () => ({ t: () => "translated" }),
}));

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function makeWrapper(qc: QueryClient, surfaceKey: string) {
  const store = getIssueSurfaceViewStore(surfaceKey);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ViewStoreProvider store={store}>{children}</ViewStoreProvider>
      </QueryClientProvider>
    );
  };
}

describe("List status branches with a catalog-id selection", () => {
  let qc: QueryClient;
  let listIssueTableRows: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    listIssueTableRows = vi.fn(async (request: any) => ({
      query_fingerprint: "test",
      group_key: request.group_key,
      parent_id: null,
      total: 0,
      rows: [],
      branch_total: 0,
      next_cursor: null,
    }));
    setApiInstance({
      // The endpoint returns a catalog envelope; issueStatusListOptions selects
      // `.statuses` off it.
      listIssueStatuses: vi.fn(async () => ({
        statuses: CATALOG,
        total: CATALOG.length,
        aliases: {},
        category_defaults: {},
      })),
      listIssueTableRows,
      listIssueTableGroups: vi.fn(() => never()),
      listIssueTableFacets: vi.fn(() => never()),
      listIssues: vi.fn(() => never()),
      listGroupedIssues: vi.fn(() => never()),
      listProjects: vi.fn(() => never()),
      getAgentTaskSnapshot: vi.fn(() => never()),
      getWorkspaceWorkingAgents: vi.fn(async () => []),
      getChildIssueProgress: vi.fn(() => never()),
    } as unknown as ApiClient);
    pruneIssueSurfaceViewStates([]);
  });

  afterEach(() => {
    cleanup();
    qc.clear();
    pruneIssueSurfaceViewStates([]);
    vi.restoreAllMocks();
  });

  async function renderListWithSelection(scopeKey: string, selection: string) {
    const store = getIssueSurfaceViewStore(scopeKey);
    store.getState().setViewMode("list");
    store.getState().toggleStatusFilter(selection);

    const { result } = renderHook(
      () =>
        useIssueSurfaceController({
          scope: { type: "workspace", actorKind: "all" },
          modes: ["list", "board"],
        }),
      { wrapper: makeWrapper(qc, scopeKey) },
    );
    await waitFor(() => expect(listIssueTableRows).toHaveBeenCalled());
    return result;
  }

  it("selecting a BUILT-IN status by catalog id still fetches its lane", async () => {
    const result = await renderListWithSelection("workspace:all", TODO_ID);

    // The regression: a UUID matched no legacy token, so no branch was fetched
    // and the surface rendered zero rows. Wait for the catalog to settle — until
    // it does, every lane is shown on purpose (never an empty surface).
    await waitFor(() =>
      expect(result.current.visibleStatuses).toEqual(["todo"]),
    );

    const keys = listIssueTableRows.mock.calls.map((c) => c[0].group_key);
    expect(keys).toContain("status:todo");
    // And the request still narrows by the exact catalog id.
    expect(listIssueTableRows).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          filters: expect.objectContaining({ status_ids: [TODO_ID] }),
        }),
      }),
    );
  });

  it("selecting a CUSTOM status by catalog id fetches its Category lane", async () => {
    const result = await renderListWithSelection("workspace:all", NEEDS_QA_ID);

    // A custom status has no lane of its own yet, so it renders inside the lane
    // of its Category — but the query still narrows to that exact status, so the
    // rows shown are the custom status's own.
    await waitFor(() =>
      expect(result.current.visibleStatuses).toEqual(["in_progress"]),
    );

    const keys = listIssueTableRows.mock.calls.map((c) => c[0].group_key);
    expect(keys).toContain("status:in_progress");
    expect(listIssueTableRows).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          filters: expect.objectContaining({ status_ids: [NEEDS_QA_ID] }),
        }),
      }),
    );
  });
});
