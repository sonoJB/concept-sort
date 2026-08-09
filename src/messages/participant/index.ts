import { ko } from "./ko";
import { ja } from "./ja";
import type { MessageShape } from "./types";

export type { MessageShape } from "./types";
export type ParticipantLocale = "ko" | "ja";

export const participantMessages: Record<ParticipantLocale, MessageShape> = { ko, ja };

export function getParticipantMessages(locale: ParticipantLocale): MessageShape {
  return participantMessages[locale];
}
