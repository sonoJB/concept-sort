import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computeGroupBounds } from "@/lib/groupBounds";

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

const GENDERS = new Set(["남자", "여자"]);
const SCHOOL_LEVELS = new Set(["중학교", "고등학교"]);
const GRADES = new Set(["1학년", "2학년", "3학년"]);

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
    return NextResponse.json(
      { error: "연구 참여 동의가 필요합니다." },
      { status: 400 }
    );
  }

  const gender = typeof body?.gender === "string" ? body.gender : "";
  const schoolLevel =
    typeof body?.schoolLevel === "string" ? body.schoolLevel : "";
  const grade = typeof body?.grade === "string" ? body.grade : "";
  const phoneNumber =
    typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
  const age = Number(body?.age);

  if (!GENDERS.has(gender)) {
    return NextResponse.json({ error: "성별을 선택해 주세요." }, { status: 400 });
  }
  if (!Number.isInteger(age) || age <= 0 || age > 120) {
    return NextResponse.json(
      { error: "연령을 올바르게 입력해 주세요." },
      { status: 400 }
    );
  }
  if (!SCHOOL_LEVELS.has(schoolLevel)) {
    return NextResponse.json({ error: "학교급을 선택해 주세요." }, { status: 400 });
  }
  if (!GRADES.has(grade)) {
    return NextResponse.json({ error: "학년을 선택해 주세요." }, { status: 400 });
  }
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "답례품 발송을 위한 전화번호를 입력해 주세요." },
      { status: 400 }
    );
  }

  const groups: IncomingGroup[] = Array.isArray(body?.groups) ? body.groups : [];
  const nonEmptyGroups = groups.filter(
    (g) => Array.isArray(g.statementIds) && g.statementIds.length > 0
  );

  if (nonEmptyGroups.length === 0) {
    return NextResponse.json(
      { error: "최소 1개 이상의 묶음에 진술문을 배치해 주세요." },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({
    where: { slug },
    include: { statements: true },
  });
  if (!project) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const validStatementIds = new Set(project.statements.map((s) => s.id));
  const seenStatementIds = new Set<string>();
  for (const group of nonEmptyGroups) {
    for (const id of group.statementIds) {
      if (!validStatementIds.has(id)) {
        return NextResponse.json(
          { error: "유효하지 않은 진술문이 포함되어 있습니다." },
          { status: 400 }
        );
      }
      if (seenStatementIds.has(id)) {
        return NextResponse.json(
          { error: "같은 진술문이 두 개 이상의 묶음에 배치되어 있습니다." },
          { status: 400 }
        );
      }
      seenStatementIds.add(id);
    }
  }

  if (seenStatementIds.size < validStatementIds.size) {
    return NextResponse.json(
      {
        error:
          "아직 분류되지 않은 진술문이 있습니다. 모든 진술문을 하나 이상의 묶음에 배치해 주세요.",
      },
      { status: 400 }
    );
  }

  if (nonEmptyGroups.length === 1) {
    return NextResponse.json(
      { error: "모든 카드를 하나의 묶음으로 만들 수 없습니다." },
      { status: 400 }
    );
  }

  const tooSmall = nonEmptyGroups.some((g) => g.statementIds.length < 2);
  if (tooSmall) {
    return NextResponse.json(
      { error: "묶음은 반드시 2장 이상의 카드로 구성되어야 합니다." },
      { status: 400 }
    );
  }

  const { maxCardsPerGroup } = computeGroupBounds(project.statements.length);
  const tooBig = nonEmptyGroups.some(
    (g) => g.statementIds.length > maxCardsPerGroup
  );
  if (tooBig) {
    return NextResponse.json(
      { error: "하나의 묶음에는 전체 진술문의 1/3 이상을 묶을 수 없습니다." },
      { status: 400 }
    );
  }

  await prisma.sortSession.create({
    data: {
      projectId: project.id,
      participantName,
      consentAgreed: true,
      gender,
      age,
      schoolLevel,
      grade,
      phoneNumber,
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
