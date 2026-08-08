import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProjectFromRequest } from "@/lib/analysis/auth";
import { filterSessionsForScope, type AnalysisScope } from "@/lib/conceptAnalysis";
import { toFixtureProject, toFixtureSessions } from "@/lib/analysis/dbAdapter";

function isValidScope(value: unknown): value is AnalysisScope {
  return value === "KR" || value === "JP" || value === "ALL";
}

/** Aggregate-only, PII-free summary of what an analysis run would see for this scope right now. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const check = await requireAdminProjectFromRequest(request, slug);
  if ("error" in check) {
    return NextResponse.json({ errorCode: check.error }, { status: check.status });
  }

  const scope = request.nextUrl.searchParams.get("scope");
  if (!isValidScope(scope)) {
    return NextResponse.json({ errorCode: "SCOPE_INVALID" }, { status: 422 });
  }

  const [statements, sessions] = await Promise.all([
    prisma.statement.findMany({ where: { projectId: check.project.id } }),
    prisma.sortSession.findMany({ where: { projectId: check.project.id }, include: { groups: { include: { items: true } } } }),
  ]);

  const fixtureProject = toFixtureProject(check.project.id, statements);
  const fixtureSessions = toFixtureSessions(
    sessions.map((s) => ({ id: s.id, countryCode: s.countryCode, groups: s.groups.map((g) => ({ items: g.items.map((i) => ({ statementId: i.statementId })) })) }))
  );
  const scopeResult = filterSessionsForScope(fixtureProject, fixtureSessions, scope);

  return NextResponse.json({
    scope,
    statementCount: statements.length,
    nKr: scopeResult.nKr,
    nJp: scopeResult.nJp,
    nTotal: scopeResult.nKr + scopeResult.nJp,
    includedParticipantCount: scopeResult.validSessions.length,
    excludedNullCountry: scopeResult.exclusions.excludedNullCountry,
    excludedIncomplete: scopeResult.exclusions.excludedIncomplete,
    excludedInvalid: scopeResult.exclusions.excludedDuplicate + scopeResult.exclusions.excludedInvalidStatement,
  });
}
