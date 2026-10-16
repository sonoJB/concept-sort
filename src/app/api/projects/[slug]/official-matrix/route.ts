import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import {
  buildOfficialMatrix,
  isOfficialScope,
  type OfficialSessionInput,
  type OfficialStatement,
} from "@/lib/officialMatrix/build";
import {
  buildOfficialMatrixWorkbook,
  officialMatrixAsciiFileName,
  officialMatrixFileName,
} from "@/lib/officialMatrix/workbook";

/**
 * Admin-only official 본조사 similarity-matrix download.
 *
 * - `scope` (ALL | KR | JP) is REQUIRED and is the only thing that selects the
 *   country range: it never defaults, and nothing about the admin screen's
 *   current country / phase selection is read here. Each download button
 *   sends its own scope explicitly.
 * - The study phase is not a parameter: the population is always dataRole=MAIN.
 *   A `dataset` parameter, if sent at all, must be exactly "MAIN" (anything
 *   else fails closed with 422) — pilots can never be requested through here.
 * - `format=xlsx` (default) returns the workbook; `format=json` returns the
 *   counts/exclusions summary the admin screen shows next to each button.
 * - The admin token is accepted from the `x-admin-token` header (preferred, so
 *   it stays out of URLs/logs) or the `token` query parameter (same as the
 *   other admin routes). Never cached.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const adminToken = request.headers.get("x-admin-token") ?? request.nextUrl.searchParams.get("token");

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status, headers: { "Cache-Control": "no-store" } });
  }

  const noStore = { "Cache-Control": "no-store" };
  const sp = request.nextUrl.searchParams;

  const scopeParam = sp.get("scope");
  if (!isOfficialScope(scopeParam)) {
    return NextResponse.json(
      { error: "scope는 ALL, KR, JP 중 하나로 명시해야 합니다." },
      { status: 422, headers: noStore }
    );
  }
  const datasetParam = sp.get("dataset");
  if (datasetParam !== null && datasetParam !== "MAIN") {
    return NextResponse.json(
      { error: "공식 본조사 행렬은 dataset=MAIN만 지원합니다." },
      { status: 422, headers: noStore }
    );
  }
  const format = sp.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "json") {
    return NextResponse.json({ error: "format은 xlsx 또는 json이어야 합니다." }, { status: 422, headers: noStore });
  }

  let asOf: Date | null = null;
  const asOfParam = sp.get("asOf");
  if (asOfParam !== null) {
    const parsed = new Date(asOfParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "asOf는 올바른 ISO 일시여야 합니다." }, { status: 422, headers: noStore });
    }
    asOf = parsed;
  }

  // One read transaction => statements and sessions come from the same moment.
  const [statementRows, sessionRows] = await prisma.$transaction([
    prisma.statement.findMany({ where: { projectId: check.project.id }, orderBy: { order: "asc" } }),
    prisma.sortSession.findMany({
      where: { projectId: check.project.id },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const statements: OfficialStatement[] = statementRows.map((s) => ({
    id: s.id,
    order: s.order,
    textKo: s.text,
    textJa: s.textJa,
    jaStatus: s.jaStatus,
  }));
  const sessions: OfficialSessionInput[] = sessionRows.map((s) => ({
    id: s.id,
    countryCode: s.countryCode,
    dataRole: s.dataRole,
    createdAt: s.createdAt,
    groups: s.groups.map((g) => g.items.map((i) => i.statementId)),
  }));

  const common = { projectKey: check.project.slug, statements, sessions, asOf };
  const result = buildOfficialMatrix({ ...common, scope: scopeParam });
  const snapshotAll = scopeParam === "ALL" ? result : buildOfficialMatrix({ ...common, scope: "ALL" });
  const generatedAt = new Date();

  if (format === "json") {
    return NextResponse.json(
      {
        scope: result.scope,
        dataset: "MAIN",
        asOf: result.asOf,
        generatedAt: generatedAt.toISOString(),
        statementCount: statements.length,
        nKr: result.nKr,
        nJp: result.nJp,
        nTotal: result.nTotal,
        exclusionCounts: result.exclusionCounts,
        sourceFingerprint: result.sourceFingerprint,
        scopeFingerprint: result.scopeFingerprint,
        snapshotAll: { nKr: snapshotAll.nKr, nJp: snapshotAll.nJp, nTotal: snapshotAll.nTotal },
      },
      { headers: noStore }
    );
  }

  const bytes = buildOfficialMatrixWorkbook(result, {
    project: { id: check.project.id, slug: check.project.slug, title: check.project.title },
    generatedAt,
    codeVersion: process.env.APP_BUILD_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
    snapshotAll,
  });

  const utf8Name = encodeURIComponent(officialMatrixFileName(scopeParam, generatedAt));
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...noStore,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${officialMatrixAsciiFileName(scopeParam, generatedAt)}"; filename*=UTF-8''${utf8Name}`,
      "X-Official-Matrix-Scope": scopeParam,
      "X-Official-Matrix-N": String(result.nTotal),
    },
  });
}
