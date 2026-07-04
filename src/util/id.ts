let counter = 0

export function newId(prefix: string): string {
  counter = (counter + 1) % 36 ** 2
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  const seq = counter.toString(36).padStart(2, "0")
  return `${prefix}_${time}${seq}${rand}`
}
