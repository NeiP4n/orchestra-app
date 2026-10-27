import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createOptimisticMutation } from "../src/solid/optimistic"

describe("createOptimisticMutation", () => {
  test("applies optimistic update immediately, commits on success, and manages isPending", async () => {
    const [items, setItems] = createSignal<string[]>(["item-1"])

    let serverCompleted = false
    const mutate = createOptimisticMutation([items, setItems], {
      update: (current, payload: string) => [...current, payload],
      mutate: async (payload: string) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        serverCompleted = true
        return { success: true, item: payload }
      },
    })

    expect(items()).toEqual(["item-1"])
    expect(mutate.isPending()).toBe(false)
    expect(mutate.pendingCount()).toBe(0)

    const promise = mutate("item-2")

    // Immediately updated optimistically before server responds
    expect(serverCompleted).toBe(false)
    expect(items()).toEqual(["item-1", "item-2"])
    expect(mutate.isPending()).toBe(true)
    expect(mutate.pendingCount()).toBe(1)

    const result = await promise

    expect(result).toEqual({ success: true, item: "item-2" })
    expect(serverCompleted).toBe(true)
    expect(items()).toEqual(["item-1", "item-2"])
    expect(mutate.isPending()).toBe(false)
    expect(mutate.pendingCount()).toBe(0)
    expect(mutate.error()).toBeUndefined()
  })

  test("automatically rolls back state to pre-mutation snapshot when mutation rejects", async () => {
    const initialList = [{ id: "1", text: "Buy milk" }]
    const [todos, setTodos] = createSignal(initialList)

    const onErrorCalls: any[] = []
    const mutate = createOptimisticMutation({
      state: todos,
      setState: setTodos,
      update: (current, payload: { id: string; text: string }) => [...current, payload],
      mutate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        throw new Error("Network timeout: 504 Gateway Timeout")
      },
      onError: (err, payload, snapshot) => {
        onErrorCalls.push({ err, payload, snapshot })
      },
    })

    const payload = { id: "2", text: "Walk dog" }
    const promise = mutate(payload)

    // Optimistic state applied
    expect(todos()).toEqual([
      { id: "1", text: "Buy milk" },
      { id: "2", text: "Walk dog" },
    ])
    expect(mutate.isPending()).toBe(true)

    // Await failure
    await expect(promise).rejects.toThrow("Network timeout: 504 Gateway Timeout")

    // State is automatically rolled back to initialList!
    expect(todos()).toEqual(initialList)
    expect(mutate.isPending()).toBe(false)
    expect(mutate.pendingCount()).toBe(0)
    expect((mutate.error() as Error)?.message).toBe("Network timeout: 504 Gateway Timeout")

    // Verify onError hook was notified
    expect(onErrorCalls).toHaveLength(1)
    expect(onErrorCalls[0].payload).toEqual(payload)
    expect(onErrorCalls[0].snapshot).toEqual(initialList)
  })

  test("supports onSuccess callback to reconcile canonical server state", async () => {
    type Message = { id: string; text: string; pending?: boolean }
    const [messages, setMessages] = createSignal<Message[]>([{ id: "msg_1", text: "Hello" }])

    const mutate = createOptimisticMutation([messages, setMessages], {
      update: (current, text: string) => [...current, { id: "temp_id", text, pending: true }],
      mutate: async (text: string) => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return { serverId: "msg_2_confirmed", text }
      },
      onSuccess: (result, _payload, current) => {
        return current.map((m) =>
          m.id === "temp_id" ? { id: result.serverId, text: result.text, pending: false } : m,
        )
      },
    })

    const promise = mutate("How are you?")
    expect(messages()).toEqual([
      { id: "msg_1", text: "Hello" },
      { id: "temp_id", text: "How are you?", pending: true },
    ])

    await promise

    expect(messages()).toEqual([
      { id: "msg_1", text: "Hello" },
      { id: "msg_2_confirmed", text: "How are you?", pending: false },
    ])
  })

  test("resets error signal with resetError", async () => {
    const [value, setValue] = createSignal(10)
    const mutate = createOptimisticMutation([value, setValue], {
      update: (curr, add: number) => curr + add,
      mutate: async () => {
        throw new Error("Validation error")
      },
    })

    try {
      await mutate(5)
    } catch {}

    expect(value()).toBe(10)
    expect((mutate.error() as Error)?.message).toBe("Validation error")

    mutate.resetError()
    expect(mutate.error()).toBeUndefined()
  })
})
