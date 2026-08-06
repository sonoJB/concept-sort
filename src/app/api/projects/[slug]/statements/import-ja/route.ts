import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminProject } from "@/lib/auth";
import { parseCsvRecords } from "@/lib/csv";

type PlannedChange = {
  statementId: string;
  order: number;
  textKo: string;
  oldTextJa: string | null;
  newTextJa: string | null;
  oldJaStatus: string;
  newJaStatus: string;
  changed: boolean;
};

/**
 * Validates a Japanese-translation CSV against the project's current
 * statements and computes what would change, without writing anything.
 * Returns `errors` for anything that must block the import entirely
 * (unknown/duplicate statementId, order mismatch, duplicate order) and
 * `warnings` for things worth flagging but not blocking (textKo drifted
 * from the DB's current text — informational only, textKo is never written).
 */
async function planImport(projectId: string, csvText: string) {
  const records = parseCsvRecords(csvText);
  const statements = await prisma.statement.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
  });
  const byId = new Map(statements.map((s) => [s.id, s]));

  const errors: string[] = [];
  const warnings: string[] = [];
  const changes: PlannedChange[] = [];
  const seenIds = new Set<string>();
  const seenOrders = new Set<string>();

  for (const [i, record] of records.entries()) {
    const rowNum = i + 2; // header is row 1
    const statementId = record.statementId?.trim();
    const orderRaw = record.order?.trim();
    const textKo = record.textKo ?? "";
    const textJaRaw = record.textJa ?? "";
    const jaStatusRaw = (record.jaStatus ?? "").trim().toUpperCase();

    if (!statementId) {
      errors.push(`${rowNum}행: statementId가 비어 있습니다.`);
      continue;
    }
    if (seenIds.has(statementId)) {
      errors.push(`${rowNum}행: statementId가 중복되었습니다 (${statementId}).`);
      continue;
    }
    seenIds.add(statementId);

    const statement = byId.get(statementId);
    if (!statement) {
      errors.push(`${rowNum}행: 이 프로젝트에 속하지 않은 statementId입니다 (${statementId}).`);
      continue;
    }

    const order = Number(orderRaw);
    if (!Number.isInteger(order)) {
      errors.push(`${rowNum}행: order 값이 올바르지 않습니다 (${orderRaw}).`);
      continue;
    }
    if (seenOrders.has(String(order))) {
      errors.push(`${rowNum}행: order 값이 중복되었습니다 (${order}).`);
      continue;
    }
    seenOrders.add(String(order));

    if (order !== statement.order) {
      errors.push(
        `${rowNum}행: order가 DB와 일치하지 않습니다 (CSV=${order}, DB=${statement.order}). statementId=${statementId}`
      );
      continue;
    }

    if (textKo && textKo !== statement.text) {
      warnings.push(
        `${rowNum}행: textKo가 DB의 한국어 원문과 다릅니다 (statementId=${statementId}). textKo는 참고용이며 저장되지 않습니다.`
      );
    }

    const newTextJa = textJaRaw.trim() ? textJaRaw.trim() : null;
    let newJaStatus: string;
    if (!newTextJa) {
      newJaStatus = "MISSING";
    } else if (newTextJa !== statement.textJa) {
      // Any content change forces DRAFT — CSV can never grant APPROVED.
      newJaStatus = "DRAFT";
    } else {
      newJaStatus = statement.jaStatus;
    }

    if (jaStatusRaw === "APPROVED" && newJaStatus !== "APPROVED") {
      warnings.push(
        `${rowNum}행: CSV의 jaStatus=APPROVED는 무시됩니다. 번역 내용 변경 시 자동 승인되지 않으며 관리자 화면에서 별도로 승인해야 합니다 (statementId=${statementId}).`
      );
    }

    changes.push({
      statementId,
      order: statement.order,
      textKo: statement.text,
      oldTextJa: statement.textJa,
      newTextJa,
      oldJaStatus: statement.jaStatus,
      newJaStatus,
      changed: newTextJa !== statement.textJa || newJaStatus !== statement.jaStatus,
    });
  }

  // Any statement missing from the CSV entirely is left untouched — not an error.
  return { errors, warnings, changes, totalRows: records.length };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  const adminToken = typeof body?.adminToken === "string" ? body.adminToken : null;
  const csvText = typeof body?.csv === "string" ? body.csv : null;
  const apply = body?.apply === true;

  const check = await requireAdminProject(slug, adminToken);
  if ("error" in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  if (!csvText) {
    return NextResponse.json({ error: "csv 텍스트가 필요합니다." }, { status: 400 });
  }

  const plan = await planImport(check.project.id, csvText);

  if (plan.errors.length > 0) {
    return NextResponse.json(
      { mode: "dry-run", ok: false, ...plan, changed: [] },
      { status: 400 }
    );
  }

  if (!apply) {
    return NextResponse.json({ mode: "dry-run", ok: true, ...plan });
  }

  const toApply = plan.changes.filter((c) => c.changed);
  await prisma.$transaction([
    ...toApply.map((c) =>
      prisma.statement.update({
        where: { id: c.statementId },
        data: { textJa: c.newTextJa, jaStatus: c.newJaStatus },
      })
    ),
    prisma.project.update({
      where: { id: check.project.id },
      data: { jaPreviewConfirmedAt: null, japaneseEnabled: false },
    }),
  ]);

  return NextResponse.json({ mode: "applied", ok: true, appliedCount: toApply.length, ...plan });
}
