import type { Skill } from "@/skills/types"
import { createSkill } from "@/skills/bundled/create-skill"

/** Built-in skills, registered as defaults; a same-named disk skill overrides them. */
export function bundledSkills(): Skill[] {
  return [createSkill]
}
