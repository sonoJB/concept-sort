import type { ExportPayload } from "./exportPayload";
import { SHEPARD_UNAVAILABLE_MESSAGE } from "./uiState";

export function buildReadmeText(payload: ExportPayload): string {
  const m = payload.meta;
  return `개념도 분석 결과 묶음 안내
========================

- 2차원 지도(map_2d.*)가 대표 개념도입니다. 사분면 보조자료(map_2d_quadrants.*)와 3차원 결과(map_3d.*, 있는 경우)는 모두 보조자료입니다.
- MDS 축의 방향·부호·회전·반사에는 본질적 의미가 없습니다. 좌표 자체를 높음/낮음, 좋음/나쁨으로 해석하지 마십시오.
- Stress 값에는 보편적인 절대 합격/불합격 절단점을 적용하지 않았습니다. 차원별 Stress는 진단 참고용입니다.
- Shepard 도표: ${SHEPARD_UNAVAILABLE_MESSAGE}
- Ward 군집분석(ward_linkage.csv, dendrogram)은 2차원 MDS 좌표(dimension=${m.wardSourceDimension})의 Euclidean geometry를 입력으로 사용합니다. 계층적 군집분석 자체가 좌표를 생성하지는 않습니다.
- scope=ALL은 한국·일본 참여자를 participant-level로 통합한 분석이며, 국가별 동일 가중치 비교나 한일 차이 검증이 아닙니다.
- 최종 군집 수(k)는 연구자가 직접 선택했습니다(자동 추천 아님).

Software provenance
--------------------
algorithmVersion: ${m.algorithmVersion}
engineSourceCommitSha: ${m.engineSourceCommitSha}
validationBaselineSha: ${m.validationBaselineSha}
parameterHash: ${m.parameterHash}
numericDataHash: ${m.numericDataHash}

Run
---
run_id: ${m.runId}
scope: ${m.scope}
started_at: ${m.startedAt}
finished_at: ${m.finishedAt ?? ""}
included_n: ${m.includedParticipantCount} (KR ${m.nKr} / JP ${m.nJp})
export_generated_at: ${m.exportGeneratedAt}
export_language: ${m.exportLanguage}
interpretation: ${m.interpretationStatus ?? "-"} (version ${m.interpretationVersion ?? "-"}, k=${m.selectedClusterCount ?? "-"})
`;
}
