import React from "react"
import { Box, Static, Text, useApp, useStdout } from "ink"
import type { AppController } from "@/ui/controller"
import { MessageView, AssistantView } from "@/ui/components/Message"
import { StatusBar } from "@/ui/components/StatusBar"
import { InputBox } from "@/ui/components/InputBox"
import { ModelPicker, buildModelOptions } from "@/ui/components/ModelPicker"
import { PermissionDialog } from "@/ui/components/PermissionDialog"
import { runCommand } from "@/commands/registry"
import { theme } from "@/ui/theme"

type Overlay = { kind: "none" } | { kind: "model" }

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
      applyEffect(runCommand(value))
      return
    }
    void controller.submit(value)
  }

  const applyEffect = (effect: ReturnType<typeof runCommand>): void => {
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
      case "exit":
        controller.exit()
        exit()
        break
      case "resume":
      case "compact":
      case "toggle-plan":
      case "show-permissions":
      case "show-mcp":
        controller.addNotice(`/${effect.kind.replace(/^(show-|toggle-)/, "")} is not available yet`, "warn")
        break
      case "none":
        break
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

      <Box marginTop={1} flexDirection="column">
        <InputBox
          onSubmit={handleSubmit}
          onAbort={() => controller.abort()}
          busy={state.busy}
          disabled={overlayActive}
        />
        <StatusBar status={state.status} busy={state.busy} />
      </Box>
    </Box>
  )
}
