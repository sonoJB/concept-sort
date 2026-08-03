import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { buildSimilarityMatrix } from "@/lib/similarity";
import { classicalMDS } from "@/lib/mds";
import { defaultClusterCount, hierarchicalClusters } from "@/lib/clustering";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const adminToken = request.nextUrl.searchParams.get("token");
  const kParam = request.nextUrl.searchParams.get("k");

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const [statements, sessions] = await Promise.all([
    prisma.statement.findMany({
      where: { projectId: check.project.id },
      orderBy: { order: "asc" },
    }),
    prisma.sortSession.findMany({
      where: { projectId: check.project.id },
      include: { groups: { include: { items: true } } },
    }),
  ]);

  const statementIds = statements.map((s) => s.id);
  const sortedSessions = sessions.map((session) => ({
    groups: session.groups.map((group) => ({
      statementIds: group.items.map((item) => item.statementId),
    })),
  }));

  if (statementIds.length === 0) {
    return NextResponse.json({
      submissionCount: sessions.length,
      points: [],
      clusters: [],
    });
  }

  const similarity = buildSimilarityMatrix(statementIds, sortedSessions);
  const distance = similarity.map((row) => row.map((s) => 1 - s));

  const k = kParam ? parseInt(kParam, 10) : defaultClusterCount(statementIds.length);
  const safeK = Number.isFinite(k) && k > 0 ? k : defaultClusterCount(statementIds.length);

  const coords = sessions.length > 0 ? classicalMDS(distance) : statementIds.map(() => ({ x: 0, y: 0 }));
  const clusterLabels =
    sessions.length > 0 ? hierarchicalClusters(distance, safeK) : statementIds.map((_, i) => i);

  const points = statements.map((statement, i) => ({
    statementId: statement.id,
    text: statement.text,
    x: coords[i].x,
    y: coords[i].y,
    clusterId: clusterLabels[i],
  }));

  const clusterMap = new Map<number, string[]>();
  points.forEach((p) => {
    const list = clusterMap.get(p.clusterId) ?? [];
    list.push(p.statementId);
    clusterMap.set(p.clusterId, list);
  });

  const clusters = Array.from(clusterMap.entries()).map(([clusterId, statementIds]) => ({
    clusterId,
    statementIds,
  }));

  return NextResponse.json({
    submissionCount: sessions.length,
    clusterCount: safeK,
    points,
    clusters,
  });
}
