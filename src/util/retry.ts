import { ZCodeError, toZCodeError } from "@/util/errors"

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 500
  const max = options.maxDelayMs ?? 8000
  let lastError: ZCodeError | undefined
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.signal?.aborted) throw new ZCodeError("aborted", "interrupted")
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = toZCodeError(error)
      if (!lastError.retryable || attempt === options.retries) throw lastError
      const delay = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() * 0.5)
      await sleep(delay, options.signal)
    }
  }
  throw lastError ?? new ZCodeError("internal", "retry loop exhausted")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ZCodeError("aborted", "interrupted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
