import type { FileDiffInfo, SessionMessageInfo, SessionStatus } from "@orchestra/client/promise"

export type SessionDocument = {
  sessionID: string
  messages: SessionMessageInfo[]
  status: SessionStatus
  diffs: FileDiffInfo[]
}
