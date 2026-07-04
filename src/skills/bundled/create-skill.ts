import type { Skill } from "@/skills/types"

const BODY = `# Create a skill

Help the user turn a repeatable workflow into a reusable **skill**. A skill is a directory that
holds a single \`SKILL.md\` file: YAML frontmatter followed by a Markdown body of instructions.
ZCode shows the model only each skill's name and description; the body is loaded on demand when the
skill is invoked. So write a body that stands on its own.

## Steps

1. **Name it.** Choose a short, lowercase, hyphenated name (for example \`release-notes\` or
   \`review-pr\`). The directory name is the skill's invocation name.
2. **Decide where it lives.** Project skills go in \`.zcode/skills/<name>/SKILL.md\` (checked in,
   shared with the team). Personal skills go in \`~/.config/zcode/skills/<name>/SKILL.md\`.
3. **Write the frontmatter.** Include at least \`name\` and \`description\`. Add other fields only when
   the workflow needs them (see the reference below).
4. **Write the body.** Give clear, ordered instructions the way you would brief a capable colleague.
   Reference any helper files by relative path; put scripts or templates next to \`SKILL.md\` and they
   will be listed when the skill loads.
5. **Save the file** with the \`write\` tool, then tell the user how to run it: the model can call the
   \`skill\` tool with the name, and the user can type \`/<name>\`.

## Frontmatter reference

\`\`\`yaml
---
name: review-pr                      # required — must match the directory name
description: Review a pull request diff for bugs, style, and missing tests.  # required — one line
when_to_use: the user asks for a code review   # optional — sharpens when the model reaches for it
argument-hint: "<pr-number>"         # optional — shown in the slash menu
arguments: [pr]                      # optional — names for $1, $2, ... in the body
allowed-tools: [bash(gh:*)]          # optional — tools temporarily granted while the skill runs
context: inline                      # optional — "inline" (default) or "fork" (runs in a subagent)
disable-model-invocation: false      # optional — true hides it from the model; only /name runs it
paths: ["**/*.rs"]                   # optional — only surfaces after a matching file is touched
---
\`\`\`

## Variables you can use in the body

- \`$ARGUMENTS\` — everything passed after the skill name.
- \`$1\`, \`$2\`, ... — positional arguments; \`$name\` maps to the \`arguments\` list.
- \`\${SKILL_DIR}\` — the absolute path of the skill's own directory.
- \`\${SESSION_ID}\` — the current session id.

## Writing a good description

The description is the only thing the model sees until the skill is loaded, so make it earn its
place: say what the skill does and, through \`when_to_use\`, when to reach for it. Keep it to one line.

Confirm the name and location with the user before writing, then create the \`SKILL.md\`.`

/** A built-in skill that guides authoring a new SKILL.md. Overridable by a same-named disk skill. */
export const createSkill: Skill = {
  name: "create-skill",
  description: "Scaffold a new SKILL.md that captures a repeatable workflow as a reusable skill.",
  whenToUse: "the user wants to save a workflow as a reusable skill",
  context: "inline",
  userInvocable: true,
  disableModelInvocation: false,
  source: "bundled",
  dir: "",
  location: "<bundled>",
  body: BODY,
}
