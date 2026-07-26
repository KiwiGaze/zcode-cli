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
import { ActivityIndicator } from "@/ui/components/ActivityIndicator"
import { runCommand, type CommandEffect } from "@/commands/registry"
import { listSessions, loadSession, SessionStore, type SessionSummary } from "@/session/store"
import { permissionsSummary } from "@/permissions/summary"
import { createTerminalFeedback, type TerminalFeedback } from "@/ui/terminal-feedback"
import { sanitizeTerminalLine } from "@/ui/terminal-text"
import { resolveTheme, ThemeContext } from "@/ui/theme"

type Overlay = { kind: "none" } | { kind: "model" } | { kind: "resume"; sessions: SessionSummary[] }

export function App({ controller }: { controller: AppController }): React.ReactElement {
  const theme = React.useMemo(() => resolveTheme(controller.config_.ui), [controller.config_.ui.theme])
  return (
    <ThemeContext.Provider value={theme}>
      <AppContent controller={controller} />
    </ThemeContext.Provider>
  )
}

function AppContent({ controller }: { controller: AppController }): React.ReactElement {
  const { exit } = useApp()
  const { stdout, write } = useStdout()
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [overlay, setOverlay] = React.useState<Overlay>({ kind: "none" })
  const terminalFeedback = React.useRef<TerminalFeedback | null>(null)

  React.useEffect(() => {
    const feedback = createTerminalFeedback({
      isTTY: stdout.isTTY === true,
      write,
      attention: controller.config_.ui.attention,
      terminalProgress: controller.config_.ui.terminalProgress,
    })
    terminalFeedback.current = feedback
    return () => {
      terminalFeedback.current = null
      feedback.dispose()
    }
  }, [controller, stdout.isTTY, write])

  React.useEffect(() => {
    terminalFeedback.current?.update({
      activity: state.activity,
      ...(state.permission === null ? {} : { permissionId: state.permission.request.callId }),
      completion: state.completion,
      queuedInputCount: state.queuedInputs.length,
      hasAutonomy: state.status.autonomy !== undefined,
    })
  }, [state.activity, state.completion, state.permission, state.queuedInputs.length, state.status.autonomy])

  React.useEffect(() => {
    if (state.permission !== null && overlay.kind !== "none") setOverlay({ kind: "none" })
  }, [state.permission, overlay.kind])

  const handleFocusChange = (focused: boolean): void => {
    terminalFeedback.current?.setFocused(focused)
  }

  const handleSubmit = (raw: string): void => {
    const command = raw.trim()
    if (command.startsWith("/")) {
      const skillNames = controller.skillCommands().map((skill) => skill.name)
      void applyEffect(runCommand(command, skillNames))
      return
    }
    void controller.submit(raw)
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
      case "toggle-auto":
        controller.toggleAutoMode()
        break
      case "show-permissions":
        controller.addNotice(permissionsSummary(controller.config_))
        break
      case "show-mcp":
        controller.addNotice(controller.mcpSummary())
        break
      case "show-skills":
        if (effect.reload) await controller.reloadSkills()
        controller.addNotice(controller.skillsSummary())
        break
      case "show-agents":
        if (effect.reload) await controller.reloadAgents()
        controller.addNotice(controller.agentsSummary())
        break
      case "run-skill":
        await controller.runSkill(effect.name, effect.args)
        break
      case "run-goal":
        await controller.runGoal(effect.condition)
        break
      case "run-loop":
        await controller.runLoop(effect.input)
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
  const width = stdout.columns ?? 80
  const hasPendingTool =
    state.live !== null && Object.values(state.live.tools).some((tool) => tool.status === "pending")
  const inputBusy = controller.isBusy() || state.status.autonomy !== undefined
  const focusReporting = controller.config_.ui.attention === "blurred"
  const showWelcome =
    state.history.length === 0 &&
    state.live === null &&
    state.activity.kind === "idle" &&
    state.queuedInputs.length === 0

  return (
    <Box flexDirection="column" width={width}>
      <Static items={state.history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {showWelcome ? (
        <Text wrap="truncate-end">
          zcode · {sanitizeTerminalLine(state.status.model)} · {Math.round(state.status.context.window / 1_000)}k ctx ·
          /help
        </Text>
      ) : null}

      {state.live !== null && state.live.parts.length > 0 ? (
        <AssistantView
          parts={state.live.parts}
          tools={state.live.tools}
          live
          animations={controller.config_.ui.animations}
        />
      ) : null}

      {state.activity.kind !== "idle" && state.permission === null && !hasPendingTool ? (
        <ActivityIndicator activity={state.activity} animations={controller.config_.ui.animations} />
      ) : null}

      {state.queuedInputs.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.queuedInputs.map((input, index) => (
            <Text key={index} wrap="truncate-end">
              Queued: {sanitizeTerminalLine(input.label)}
            </Text>
          ))}
          <Text wrap="truncate-end">Alt+↑ to edit all queued messages</Text>
        </Box>
      ) : null}

      {state.permission !== null ? (
        <PermissionDialog
          key={state.permission.request.callId}
          pending={state.permission}
          onDecide={(decision) => controller.resolvePermission(decision)}
          onFocusChange={handleFocusChange}
          focusReporting={focusReporting}
          isActive
        />
      ) : null}

      {state.permission === null && overlay.kind === "model" ? (
        <ModelPicker
          options={buildModelOptions(Object.keys(controller.config_.models))}
          current={{ provider: controller.config_.provider, model: controller.config_.model }}
          onSelect={(option) => {
            controller.setModel(option.provider, option.model)
            setOverlay({ kind: "none" })
          }}
          onCancel={() => setOverlay({ kind: "none" })}
          onFocusChange={handleFocusChange}
          focusReporting={focusReporting}
          isActive
        />
      ) : null}

      {state.permission === null && overlay.kind === "resume" ? (
        <ResumePicker
          sessions={overlay.sessions}
          onSelect={(session) => void doResume(session)}
          onCancel={() => setOverlay({ kind: "none" })}
          onFocusChange={handleFocusChange}
          focusReporting={focusReporting}
          isActive
        />
      ) : null}

      {overlayActive ? null : <TodoPanel todos={state.todos} />}

      <Box marginTop={1} flexDirection="column">
        <InputBox
          onSubmit={handleSubmit}
          onAbort={() => controller.abortAndTakePendingDrafts()}
          onRestoreQueue={() => controller.takePendingDrafts()}
          onFocusChange={handleFocusChange}
          focusReporting={focusReporting}
          busy={inputBusy}
          isActive={!overlayActive}
          skills={controller.skillCommands()}
        />
        <StatusBar status={state.status} activity={state.activity} width={width} />
      </Box>
    </Box>
  )
}
