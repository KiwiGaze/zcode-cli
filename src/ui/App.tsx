import React from "react"
import { Box, Static, Text, useApp, useStdout } from "ink"
import type { AppController } from "@/ui/controller"
import { MessageView, AssistantView } from "@/ui/components/Message"
import { StatusBar } from "@/ui/components/StatusBar"
import { InputBox } from "@/ui/components/InputBox"
import { ModelPicker, buildModelOptions } from "@/ui/components/ModelPicker"
import { ResumePicker } from "@/ui/components/ResumePicker"
import { PermissionDialog } from "@/ui/components/PermissionDialog"
import { TodoPanel } from "@/ui/components/TodoPanel"
import { runCommand, type CommandEffect } from "@/commands/registry"
import { listSessions, loadSession, SessionStore, type SessionSummary } from "@/session/store"
import { permissionsSummary } from "@/permissions/summary"
import { theme } from "@/ui/theme"

type Overlay =
  | { kind: "none" }
  | { kind: "model" }
  | { kind: "resume"; sessions: SessionSummary[] }

export function App({ controller }: { controller: AppController }): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [overlay, setOverlay] = React.useState<Overlay>({ kind: "none" })

  React.useEffect(() => {
    if (state.permission !== null && overlay.kind !== "none") setOverlay({ kind: "none" })
  }, [state.permission, overlay.kind])

  const handleSubmit = (raw: string): void => {
    const value = raw.trim()
    if (value.startsWith("/")) {
      void applyEffect(runCommand(value))
      return
    }
    void controller.submit(value)
  }

  const applyEffect = async (effect: CommandEffect): Promise<void> => {
    switch (effect.kind) {
      case "notice":
        controller.addNotice(effect.text, effect.tone ?? "info")
        break
      case "open-model-picker":
        setOverlay({ kind: "model" })
        break
      case "clear":
        controller.clear()
        break
      case "toggle-plan":
        controller.togglePlanMode()
        break
      case "show-permissions":
        controller.addNotice(permissionsSummary(controller.config_))
        break
      case "show-mcp":
        controller.addNotice("no MCP servers configured")
        break
      case "resume": {
        const sessions = await listSessions(controller.config_.cwd)
        setOverlay({ kind: "resume", sessions })
        break
      }
      case "compact":
        await controller.compactNow()
        break
      case "exit":
        controller.exit()
        exit()
        break
      case "none":
        break
    }
  }

  const doResume = async (session: SessionSummary): Promise<void> => {
    setOverlay({ kind: "none" })
    try {
      const loaded = await loadSession(controller.config_.cwd, session.id)
      const store = await SessionStore.reopen(controller.config_.cwd, session.id)
      controller.loadFrom(loaded, store)
      controller.addNotice(`resumed session ${session.id}`)
    } catch (error) {
      controller.addNotice(error instanceof Error ? error.message : String(error), "warn")
    }
  }

  const overlayActive = overlay.kind !== "none" || state.permission !== null
  const width = stdout?.columns ?? 80

  return (
    <Box flexDirection="column" width={width}>
      <Static items={state.history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {state.live !== null && state.live.parts.length > 0 ? (
        <AssistantView parts={state.live.parts} tools={state.live.tools} live />
      ) : null}

      {state.busy && (state.live === null || state.live.parts.length === 0) ? (
        <Box marginTop={1}>
          <Text color={theme.dim}>thinking…</Text>
        </Box>
      ) : null}

      {state.permission !== null ? (
        <PermissionDialog pending={state.permission} onDecide={(decision) => controller.resolvePermission(decision)} />
      ) : null}

      {overlay.kind === "model" ? (
        <ModelPicker
          options={buildModelOptions(Object.keys(controller.config_.models))}
          current={{ provider: controller.config_.provider, model: controller.config_.model }}
          onSelect={(option) => {
            controller.setModel(option.provider, option.model)
            setOverlay({ kind: "none" })
          }}
          onCancel={() => setOverlay({ kind: "none" })}
        />
      ) : null}

      {overlay.kind === "resume" ? (
        <ResumePicker sessions={overlay.sessions} onSelect={(session) => void doResume(session)} onCancel={() => setOverlay({ kind: "none" })} />
      ) : null}

      {overlayActive ? null : <TodoPanel todos={state.todos} />}

      <Box marginTop={1} flexDirection="column">
        <InputBox onSubmit={handleSubmit} onAbort={() => controller.abort()} busy={state.busy} disabled={overlayActive} />
        <StatusBar status={state.status} busy={state.busy} />
      </Box>
    </Box>
  )
}
