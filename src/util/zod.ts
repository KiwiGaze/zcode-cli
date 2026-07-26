import type { z } from "zod"

/** Schema failures as one line naming each bad field, for a message the model or the user reads. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}
