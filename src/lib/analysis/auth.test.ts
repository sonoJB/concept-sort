import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireAdminProject: vi.fn(),
}));

import { requireAdminProject } from "@/lib/auth";
import { requireAdminProjectFromRequest } from "./auth";

const mockRequireAdminProject = vi.mocked(requireAdminProject);

beforeEach(() => {
  mockRequireAdminProject.mockReset();
});

describe("requireAdminProjectFromRequest", () => {
  it("extracts the token from a Bearer Authorization header and delegates to requireAdminProject", async () => {
    mockRequireAdminProject.mockResolvedValue({ project: { id: "p1" } } as never);
    const req = new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer secret-token" } });
    const result = await requireAdminProjectFromRequest(req, "my-slug");
    expect(mockRequireAdminProject).toHaveBeenCalledWith("my-slug", "secret-token");
    expect("project" in result && result.project.id).toBe("p1");
  });

  it("passes null when there is no Authorization header at all", async () => {
    mockRequireAdminProject.mockResolvedValue({ error: "no", status: 403 } as never);
    const req = new NextRequest("http://localhost/api/x");
    await requireAdminProjectFromRequest(req, "my-slug");
    expect(mockRequireAdminProject).toHaveBeenCalledWith("my-slug", null);
  });

  it("maps a bad-token result (legacy 403) to 401 for this namespace", async () => {
    mockRequireAdminProject.mockResolvedValue({ error: "관리자 권한이 없습니다.", status: 403 } as never);
    const req = new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer wrong" } });
    const result = await requireAdminProjectFromRequest(req, "my-slug");
    expect("error" in result && result.status).toBe(401);
  });

  it("maps project-not-found to 404", async () => {
    mockRequireAdminProject.mockResolvedValue({ error: "프로젝트를 찾을 수 없습니다.", status: 404 } as never);
    const req = new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer whatever" } });
    const result = await requireAdminProjectFromRequest(req, "missing-slug");
    expect("error" in result && result.status).toBe(404);
  });

  it("ignores a non-Bearer Authorization scheme (treated as absent)", async () => {
    mockRequireAdminProject.mockResolvedValue({ error: "x", status: 403 } as never);
    const req = new NextRequest("http://localhost/api/x", { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    await requireAdminProjectFromRequest(req, "my-slug");
    expect(mockRequireAdminProject).toHaveBeenCalledWith("my-slug", null);
  });
});
