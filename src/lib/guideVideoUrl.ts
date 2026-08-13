const ALLOWED_HOSTS = new Set(["youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com"]);

export type GuideVideoUrlValidation =
  | { ok: true; normalized: string | null }
  | { ok: false; error: string };

/**
 * Validates an Admin-submitted 가이드라인 동영상 URL before it is ever
 * persisted. An empty/blank input is valid and normalizes to `null` — the
 * participant-facing video-guide button hides itself when the stored URL is
 * null. Anything else must be an `https://` link on an allowed YouTube host;
 * `http:`, `javascript:`, `data:`, `file:`, non-YouTube hosts, and malformed
 * URLs are all rejected the same way callers can't distinguish (server-side
 * only — never trust a client-side check alone).
 */
export function validateGuideVideoUrl(raw: unknown): GuideVideoUrlValidation {
  if (typeof raw !== "string") {
    return { ok: false, error: "URL 형식이 올바르지 않습니다." };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, normalized: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "URL 형식이 올바르지 않습니다." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "https:// 링크만 허용됩니다." };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: "YouTube 링크(youtu.be, youtube.com)만 허용됩니다." };
  }

  return { ok: true, normalized: trimmed };
}
