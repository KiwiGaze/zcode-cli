export interface PermissionRequest {
  /** Tool that wants to run. */
  tool: string
  callId: string
  /** One-line human summary, e.g. `bash: rm -rf node_modules`. */
  title: string
  /** Optional preview (command text, diff, URL). */
  detail?: string
  /** Session-scoped dedupe key: an `allow-session` decision approves this key from then on. */
  key: string
  /** The thing being acted on: a command (bash), path, pattern, or URL. Drives bash prefix rules. */
  subject: string
}

export type PermissionDecision = "allow-once" | "allow-session" | "deny"
