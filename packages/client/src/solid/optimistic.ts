import { createSignal, batch } from "solid-js"

export interface OptimisticMutationOptions<TState, TPayload, TResult = void> {
  /**
   * The Solid signal or accessor/setter tuple to apply optimistic updates to.
   */
  readonly signal?: [() => TState, (value: TState | ((prev: TState) => TState)) => void]
  readonly state?: () => TState
  readonly setState?: (value: TState | ((prev: TState) => TState)) => void

  /**
   * Optimistic update function applied immediately when mutation is invoked.
   * Receives the current state snapshot and the payload, returns the new optimistic state.
   */
  readonly update: (current: TState, payload: TPayload) => TState

  /**
   * The asynchronous operation performing the remote mutation.
   */
  readonly mutate: (payload: TPayload) => Promise<TResult>

  /**
   * Optional transform or reconciliation when server mutation succeeds.
   * If returns a value, updates state with that value.
   */
  readonly onSuccess?: (result: TResult, payload: TPayload, current: TState) => TState | void

  /**
   * Optional callback when mutation fails. Called before or alongside rollback.
   */
  readonly onError?: (error: unknown, payload: TPayload, rollbackState: TState) => void

  /**
   * Optional custom clone/snapshot function. Defaults to structuredClone or shallow copy.
   */
  readonly clone?: (state: TState) => TState
}

export interface OptimisticMutation<TPayload, TResult = void> {
  /**
   * Executes the optimistic mutation with automatic rollback on error.
   */
  (payload: TPayload): Promise<TResult>

  /**
   * Reactive signal indicating whether any mutation is currently in-flight.
   */
  readonly isPending: () => boolean

  /**
   * Reactive count of active in-flight mutations.
   */
  readonly pendingCount: () => number

  /**
   * Reactive signal holding the last mutation error, if any.
   */
  readonly error: () => unknown

  /**
   * Clears the current error signal.
   */
  readonly resetError: () => void
}

function defaultClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return [...value] as unknown as T
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value)
    } catch {}
  }
  return { ...value }
}

/**
 * Creates an optimistic mutation helper for Solid.js signals.
 * Immediately applies optimistic updates to the given state signal, executes the async operation,
 * commits state on success, and automatically rolls back to pre-mutation snapshot on failure.
 */
export function createOptimisticMutation<TState, TPayload, TResult = void>(
  signalOrOptions:
    | [() => TState, (value: TState | ((prev: TState) => TState)) => void]
    | OptimisticMutationOptions<TState, TPayload, TResult>,
  maybeOptions?: OptimisticMutationOptions<TState, TPayload, TResult>,
): OptimisticMutation<TPayload, TResult> {
  const options: OptimisticMutationOptions<TState, TPayload, TResult> = Array.isArray(signalOrOptions)
    ? {
        ...maybeOptions!,
        state: signalOrOptions[0],
        setState: signalOrOptions[1],
      }
    : signalOrOptions

  const getState = options.state ?? options.signal?.[0]
  const setState = options.setState ?? options.signal?.[1]

  if (!getState || !setState) {
    throw new Error(
      "createOptimisticMutation requires state and setState accessor/setter pair or signal tuple",
    )
  }

  const cloneFn = options.clone ?? defaultClone
  const [pendingCount, setPendingCount] = createSignal(0)
  const [error, setError] = createSignal<unknown>(undefined)

  const isPending = () => pendingCount() > 0

  const executeMutation = async (payload: TPayload): Promise<TResult> => {
    // 1. Capture snapshot before mutation for rollback
    const snapshot = cloneFn(getState())

    // 2. Apply optimistic update immediately
    batch(() => {
      setError(undefined)
      setPendingCount((c) => c + 1)
      const optimistic = options.update(snapshot, payload)
      setState(optimistic)
    })

    try {
      // 3. Execute remote mutation
      const result = await options.mutate(payload)

      // 4. Commit success
      batch(() => {
        setPendingCount((c) => Math.max(0, c - 1))
        if (options.onSuccess) {
          const updated = options.onSuccess(result, payload, getState())
          if (updated !== undefined) {
            setState(updated)
          }
        }
      })

      return result
    } catch (err) {
      // 5. Automatic rollback on failure
      batch(() => {
        setPendingCount((c) => Math.max(0, c - 1))
        setError(err)
        setState(snapshot)
        options.onError?.(err, payload, snapshot)
      })

      // Re-throw so caller knows it failed
      throw err
    }
  }

  return Object.assign(executeMutation, {
    isPending,
    pendingCount,
    error,
    resetError: () => setError(undefined),
  })
}
