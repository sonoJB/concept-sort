import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computeGroupBounds } from "@/lib/groupBounds";
import { computeLocaleContentStatus } from "@/lib/localeContentStatus";
import { GENDER_VALUES, SCHOOL_LEVEL_VALUES, GRADE_VALUES } from "@/lib/participantOptions";
import { classifySubmissionDataRole } from "@/lib/classifySubmissionDataRole";
import type { ErrorCode } from "@/lib/errorCodes";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug } });
  if (!project) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const submissionCount = await prisma.sortSession.count({
    where: { projectId: project.id },
  });

  return NextResponse.json({ submissionCount });
}

type IncomingGroup = { label?: string; statementIds: string[] };

function fail(errorCode: ErrorCode, error: string, status = 400) {
  return NextResponse.json({ errorCode, error }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);

  const participantName =
    typeof body?.participantName === "string" && body.participantName.trim()
      ? body.participantName.trim()
      : "익명 참가자";

  if (body?.consentAgreed !== true) {
    return fail("CONSENT_REQUIRED", "연구 참여 동의가 필요합니다.");
  }

  const countryCode = body?.countryCode;
  if (countryCode !== "KR" && countryCode !== "JP") {
    return fail("COUNTRY_REQUIRED", "참여 국가를 선택해 주세요.");
  }

  const gender = typeof body?.gender === "string" ? body.gender : "";
  const schoolLevel = typeof body?.schoolLevel === "string" ? body.schoolLevel : "";
  const grade = typeof body?.grade === "string" ? body.grade : "";
  const phoneNumber = typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
  const age = Number(body?.age);

  if (!GENDER_VALUES.has(gender)) {
    return fail("GENDER_REQUIRED", "성별을 선택해 주세요.");
  }
  if (!Number.isInteger(age) || age <= 0 || age > 120) {
    return fail("AGE_INVALID", "연령을 올바르게 입력해 주세요.");
  }
  if (!SCHOOL_LEVEL_VALUES.has(schoolLevel)) {
    return fail("SCHOOL_LEVEL_REQUIRED", "학교급을 선택해 주세요.");
  }
  if (!GRADE_VALUES.has(grade)) {
    return fail("GRADE_REQUIRED", "학년을 선택해 주세요.");
  }
  if (!phoneNumber) {
    return fail("PHONE_REQUIRED", "스마트폰 번호를 입력해 주세요.");
  }

  const groups: IncomingGroup[] = Array.isArray(body?.groups) ? body.groups : [];
  const nonEmptyGroups = groups.filter(
    (g) => Array.isArray(g.statementIds) && g.statementIds.length > 0
  );

  if (nonEmptyGroups.length === 0) {
    return fail("UNASSIGNED_STATEMENTS", "최소 1개 이상의 묶음에 진술문을 배치해 주세요.");
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: true },
  });
  if (!project) {
    return fail("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.", 404);
  }

  // countryCode is validated independently of gender/schoolLevel/grade — it
  // is never inferred from those display values, only checked against the
  // project's own current enabled+readiness state for that language.
  if (countryCode === "KR") {
    const koStatus = computeLocaleContentStatus("ko", project, project.statements);
    if (!project.koreanEnabled || !koStatus.ready) {
      return fail("COUNTRY_NOT_AVAILABLE", "한국어 참여를 현재 받고 있지 않습니다.");
    }
  } else {
    const jaStatus = computeLocaleContentStatus("ja", project, project.statements);
    if (!project.japaneseEnabled || !jaStatus.ready) {
      return fail("COUNTRY_NOT_AVAILABLE", "일본어 참여를 현재 받고 있지 않습니다.");
    }
  }

  const validStatementIds = new Set(project.statements.map((s) => s.id));
  const seenStatementIds = new Set<string>();
  for (const group of nonEmptyGroups) {
    for (const id of group.statementIds) {
      if (!validStatementIds.has(id)) {
        return fail("INVALID_STATEMENT", "유효하지 않은 진술문이 포함되어 있습니다.");
      }
      if (seenStatementIds.has(id)) {
        return fail(
          "INVALID_STATEMENT",
          "같은 진술문이 두 개 이상의 묶음에 배치되어 있습니다."
        );
      }
      seenStatementIds.add(id);
    }
  }

  // JP submissions may only use statements whose Japanese translation is
  // both present and approved — re-checked here even though the readiness
  // gate above already implies it for the whole project, because a
  // statement could theoretically be un-approved between page load and
  // submit.
  if (countryCode === "JP") {
    const usedStatements = project.statements.filter((s) => seenStatementIds.has(s.id));
    const notReady = usedStatements.some((s) => !s.textJa?.trim() || s.jaStatus !== "APPROVED");
    if (notReady) {
      return fail("JAPANESE_CONTENT_NOT_READY", "일본어 자료가 아직 준비되지 않았습니다.");
    }
  }

  if (seenStatementIds.size < validStatementIds.size) {
    return fail(
      "UNASSIGNED_STATEMENTS",
      "아직 분류되지 않은 진술문이 있습니다. 모든 진술문을 하나 이상의 묶음에 배치해 주세요."
    );
  }

  if (nonEmptyGroups.length === 1) {
    return fail("ONE_GROUP_ONLY", "모든 카드를 하나의 묶음으로 만들 수 없습니다.");
  }

  const tooSmall = nonEmptyGroups.some((g) => g.statementIds.length < 2);
  if (tooSmall) {
    return fail("GROUP_TOO_SMALL", "묶음은 반드시 2장 이상의 카드로 구성되어야 합니다.");
  }

  const { maxCardsPerGroup } = computeGroupBounds(project.statements.length);
  const tooBig = nonEmptyGroups.some((g) => g.statementIds.length > maxCardsPerGroup);
  if (tooBig) {
    return fail(
      "GROUP_TOO_LARGE",
      "하나의 묶음에는 전체 진술문의 1/3 이상을 묶을 수 없습니다."
    );
  }

  // Exactly one trusted server timestamp for this submission, captured
  // immediately before the write — reused for both PILOT/MAIN
  // classification and the stored createdAt, so a boundary-instant
  // submission can never be classified against one clock read and recorded
  // against a different one. Never a browser/client clock, never read from
  // `body` (there is no pilot/main selector exposed to participants).
  const receivedAt = new Date();
  const dataRole = classifySubmissionDataRole({
    receivedAt,
    mainStudyStartsAt: project.mainStudyStartsAt,
  });

  await prisma.sortSession.create({
    data: {
      projectId: project.id,
      participantName,
      createdAt: receivedAt,
      consentAgreed: true,
      gender,
      age,
      schoolLevel,
      grade,
      phoneNumber,
      countryCode,
      dataRole,
      groups: {
        create: nonEmptyGroups.map((g) => ({
          label: g.label?.trim() ?? "",
          items: {
            create: g.statementIds.map((statementId) => ({ statementId })),
          },
        })),
      },
    },
  });

  return NextResponse.json({ ok: true });
}
