import React from "react"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const STATIC_SPINNER_GLYPH = "⋯"
export const SPINNER_FRAME_INTERVAL_MS = 80

export function Spinner({ frame, animated }: { frame?: number; animated: boolean }): React.ReactElement {
  const [localFrame, setLocalFrame] = React.useState(0)

  React.useEffect(() => {
    if (!animated || frame !== undefined || SPINNER_FRAMES.length < 2) return
    const interval = setInterval(() => setLocalFrame((current) => current + 1), SPINNER_FRAME_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [animated, frame])

  const selectedFrame = frame ?? localFrame
  return <>{animated ? SPINNER_FRAMES[selectedFrame % SPINNER_FRAMES.length] : STATIC_SPINNER_GLYPH}</>
}
