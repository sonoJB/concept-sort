/** Settings of the package pipeline (analysis finished -> build -> verify -> register -> ready). */

/** Layout / document version of a package. Independent of the analysis engine version stored on the run. */
export const PACKAGE_FORMAT_VERSION = "package-format-3";

/** More versions than this per run are refused: every package is ~25 MB on a small persistent volume. */
export const MAX_PACKAGE_VERSIONS_PER_RUN = 6;

/** A job that has not reported a heartbeat for this long is treated as abandoned (server restart / crash). */
export const PACKAGE_JOB_STALE_MS = 10 * 60 * 1000;

/** Attempts per job (automatic recoveries included) before it is left FAILED for a human decision. */
export const PACKAGE_JOB_MAX_ATTEMPTS = 3;

/** Wall-clock limit of the external builder process. */
export const PACKAGE_BUILD_TIMEOUT_MS = 12 * 60 * 1000;

/** Free space required on the package volume before a build starts (ZIP ~25 MB + temp copy + backup headroom). */
export const PACKAGE_MIN_FREE_BYTES = 150 * 1024 * 1024;

export const ACTIVE_JOB_STATUSES = ["QUEUED", "BUILDING", "VERIFYING", "REGISTERING"] as const;
export type PackageJobStatus = (typeof ACTIVE_JOB_STATUSES)[number] | "READY" | "FAILED";
export type PackageJobTrigger = "AUTO" | "RETRY" | "REBUILD";

/**
 * Fixed, non-technical messages for the admin screen. The technical detail (paths, stderr, exception text) goes to the
 * server log only and is never stored in the database or returned by the API.
 */
export const PACKAGE_JOB_MESSAGES: Record<string, string> = {
  RESULT_NOT_CURRENT: "분석 결과가 최신 자료·설정과 더 이상 일치하지 않아 ZIP을 만들지 않았습니다. 새 분석을 실행하세요.",
  PACKAGE_INPUT_CHANGED: "분석 이후 응답 자료가 바뀌어 이 분석에 맞는 ZIP을 만들 수 없습니다. 새 분석을 실행하세요.",
  BUILDER_UNAVAILABLE: "서버에서 ZIP 제작 도구(Python)를 실행할 수 없습니다. 관리자 점검이 필요합니다.",
  BUILD_FAILED: "ZIP 제작 중 오류가 발생했습니다. 다시 시도할 수 있습니다(분석은 다시 계산하지 않습니다).",
  BUILD_TIMEOUT: "ZIP 제작이 제한 시간을 넘겨 중단됐습니다. 다시 시도할 수 있습니다.",
  DISK_LOW: "저장 공간이 부족해 ZIP을 만들지 않았습니다. 공간 확보 후 다시 시도하세요.",
  VERIFY_FAILED: "만들어진 ZIP이 무결성·내용 검증을 통과하지 못해 등록하지 않았습니다.",
  PERSONAL_DATA_FOUND: "만들어진 ZIP에서 개인정보로 의심되는 값이 발견되어 등록하지 않았습니다.",
  REGISTER_FAILED: "ZIP 등록 중 오류가 발생했습니다. 다시 시도할 수 있습니다.",
  TOO_MANY_VERSIONS: "이 분석의 ZIP 버전 수가 한도에 도달했습니다.",
  PACKAGE_UNCHANGED: "새로 만든 ZIP이 이미 등록된 다른 버전과 바이트까지 같아 새 버전을 만들지 않았습니다(기존 버전 유지).",
  JOB_ABANDONED: "ZIP 작업이 여러 번 중단되어 멈췄습니다(서버 재시작 등). 다시 시도할 수 있습니다.",
};
