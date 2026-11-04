/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ParentProps } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider as DataProviderBase } from "../../../src/context/data"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// UI-side recovery synchronization: the state the session screen gates on
// (LocationProvider.error / current) must follow the location sync — a
// failed identity check blocks, a successful sync of the recovered
// directory clears the block and becomes the current location, and a
// stale failure from a superseded attempt must not overwrite newer state.

const A = "/tmp/location-recovery-a"
const B = "/tmp/location-recovery-b"

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const config = createTuiResolvedConfig()

function Providers(props: ParentProps & { probe: (location: ReturnType<typeof useLocation>) => void }) {
  return (
    <ConfigProvider config={config}>
      <DataProviderBase directory={process.cwd()}>
        <LocationProvider>
          <Probe onReady={props.probe} />
          {props.children}
        </LocationProvider>
      </DataProviderBase>
    </ConfigProvider>
  )
}

function Probe(props: { onReady: (location: ReturnType<typeof useLocation>) => void }) {
  const location = useLocation()
  props.onReady(location)
  return null
}

function locationBody(directory: string) {
  return json({ directory, project: { id: "proj_test", directory, canonical: directory } })
}

test("location recovery: failure blocks, successful move target clears, stale failure cannot overwrite", async () => {
  const events = createEventStream()
  let releaseA: (() => void) | undefined
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/location") return undefined
    const directory = url.searchParams.get("location[directory]")
    if (directory === A) {
      // A slow failure, released manually to test the race guard.
      return new Promise<Response>((resolve) => {
        releaseA = () => resolve(new Response("boom", { status: 500 }))
      })
    }
    if (directory === B) return locationBody(B)
    return undefined
  }, events)

  let location!: ReturnType<typeof useLocation>
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <Providers probe={(value) => (location = value)}>
          <box />
        </Providers>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    // The session's location A fails its identity check: the provider
    // records the error the recovery screen gates on.
    location.set({ directory: A })
    await Bun.sleep(50)
    releaseA?.()
    await wait(() => location.error?.location.directory === A)

    // Rapid re-selection: A is chosen again (another slow failure starts),
    // then the user picks B, which syncs successfully first.
    location.set({ directory: A })
    await Bun.sleep(50)
    location.set({ directory: B })
    await wait(() => location.current?.directory === B)
    expect(location.error).toBeUndefined()

    // The superseded A failure now lands — it must not re-block the
    // session or replace B as the current location.
    releaseA?.()
    await Bun.sleep(100)
    expect(location.error).toBeUndefined()
    expect(location.current?.directory).toBe(B)

    // A location whose identity check fails stays recoverable: the error
    // is recorded (the recovery UI remains available), not swallowed.
    location.set({ directory: A })
    await Bun.sleep(50)
    releaseA?.()
    await wait(() => location.error?.location.directory === A)
  } finally {
    app.renderer.destroy()
  }
})
