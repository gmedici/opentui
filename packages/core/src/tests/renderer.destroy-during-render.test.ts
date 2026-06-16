import { test, expect } from "bun:test"
import { openSync, readFileSync, closeSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { CliRenderer, CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

const decoder = new TextDecoder()

class RecordingWriteStream extends Writable {
  public readonly isTTY = true
  public readonly columns: number
  public readonly rows: number
  public output = ""

  constructor(columns = 80, rows = 24) {
    super()
    this.columns = columns
    this.rows = rows
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += typeof chunk === "string" ? chunk : decoder.decode(chunk)
    callback()
  }

  getColorDepth(): number {
    return 24
  }
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1
}

class FdWriteStream extends Writable {
  public readonly fd: number
  public readonly isTTY = true
  public columns = 80
  public rows = 24
  public capturedOutput = ""

  constructor(fd: number) {
    super()
    this.fd = fd
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const str = typeof chunk === "string" ? chunk : decoder.decode(chunk)
    this.capturedOutput += str
    callback()
  }

  getColorDepth(): number {
    return 24
  }
}

class DestroyingRenderable extends Renderable {
  protected renderSelf(_buffer: OptimizedBuffer, _deltaTime: number): void {}
}

test("destroying renderer during frame callback should synchronously clean up terminal state", async () => {
  const rawModeCalls: boolean[] = []
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
    setRawMode: (enabled: boolean) => NodeJS.ReadStream
  }
  stdin.setRawMode = (enabled) => {
    rawModeCalls.push(enabled)
    return stdin
  }

  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()
  const lib = (renderer as any).lib as { suspendRenderer: (rendererPtr: unknown) => void }
  const originalSuspendRenderer = lib.suspendRenderer.bind(lib)
  let suspendCalls = 0
  let cleanupObserved = false
  let outputAtDestroyEvent = ""

  lib.suspendRenderer = (rendererPtr: unknown) => {
    suspendCalls++
    originalSuspendRenderer(rendererPtr)
  }

  renderer.once(CliRenderEvents.DESTROY, () => {
    outputAtDestroyEvent = stdout.output
  })

  renderer.setFrameCallback(async () => {
    renderer.destroy()
    cleanupObserved = true

    expect(rawModeCalls.at(-1)).toBe(false)
    expect(suspendCalls).toBe(1)
    expect(stdout.output).toContain("\x1b[?1006l")
  })

  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(cleanupObserved).toBe(true)
  expect(outputAtDestroyEvent).toContain("\x1b[?1006l")
})

test("destroy event should fire after hard terminal restore output is written", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  let outputAtDestroyEvent = ""
  const destroyed = new Promise<void>((resolve) =>
    renderer.once(CliRenderEvents.DESTROY, () => {
      outputAtDestroyEvent = stdout.output
      resolve()
    }),
  )

  const closed = renderer.destroy()
  await destroyed
  await closed

  expect(outputAtDestroyEvent).toContain("\x1b[?1003l")
  expect(outputAtDestroyEvent).toContain("\x1b[?1006l")
  expect(outputAtDestroyEvent).toContain("\x1b[?2004l")
  expect(outputAtDestroyEvent).toContain("\x1b[<u")
  expect(outputAtDestroyEvent).toContain("\x1b[r")
  expect(outputAtDestroyEvent).toContain("\x1b[?1049l")
  expect(countOccurrences(stdout.output, "\x1b[?1006l")).toBe(1)

  const outputAfterFirstDestroy = stdout.output
  await renderer.destroy()
  expect(stdout.output).toBe(outputAfterFirstDestroy)
})

test("destroying renderer during frame callback should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringRender = false

  renderer.setFrameCallback(async () => {
    destroyedDuringRender = true
    renderer.destroy()
  })

  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(destroyedDuringRender).toBe(true)

  // If we got here without a segfault, the test passes
})

test("destroying renderer during post-process should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringPostProcess = false

  renderer.addPostProcessFn(() => {
    destroyedDuringPostProcess = true
    renderer.destroy()
  })

  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(destroyedDuringPostProcess).toBe(true)

  // If we got here without a segfault, the test passes
})

test("destroying renderer during root render should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringRender = false

  // Override the root's render method to destroy the renderer
  const originalRender = renderer.root.render.bind(renderer.root)
  renderer.root.render = (buffer, deltaTime) => {
    originalRender(buffer, deltaTime)
    if (!destroyedDuringRender) {
      destroyedDuringRender = true
      renderer.destroy()
    }
  }

  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(destroyedDuringRender).toBe(true)

  // If we got here without a segfault, the test passes
})

test("destroying renderer during requestAnimationFrame should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringAnimationFrame = false

  requestAnimationFrame(() => {
    destroyedDuringAnimationFrame = true
    renderer.destroy()
  })

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(destroyedDuringAnimationFrame).toBe(true)
})

test("destroying renderer during renderBefore should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringRenderBefore = false

  const renderable = new DestroyingRenderable(renderer, {
    id: "destroy-render-before",
    width: 10,
    height: 1,
    renderBefore() {
      if (!destroyedDuringRenderBefore) {
        destroyedDuringRenderBefore = true
        renderer.destroy()
      }
    },
  })

  renderer.root.add(renderable)
  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(destroyedDuringRenderBefore).toBe(true)
})

test("writeSync(fd) path should write hard terminal restore directly to file descriptor", async () => {
  const tmpPath = join(tmpdir(), `opentui-hard-restore-test-${Date.now()}.txt`)
  let fd: number | null = null

  try {
    fd = openSync(tmpPath, "w")
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream
    const stdout = new FdWriteStream(fd)

    const renderer = new CliRenderer(stdin, stdout as unknown as NodeJS.WriteStream, 80, 24, {
      screenMode: "alternate-screen",
      consoleMode: "disabled",
      exitOnCtrlC: false,
      exitSignals: [],
      bufferedOutput: "memory",
    })

    await renderer.setupTerminal()
    renderer.destroy()

    const contents = readFileSync(tmpPath, "utf-8")

    expect(contents).toContain("\x1b[?1003l")
    expect(contents).toContain("\x1b[?1006l")
    expect(contents).toContain("\x1b[?2004l")
    expect(contents).toContain("\x1b[<u")
    expect(contents).toContain("\x1b[r")
    expect(contents).toContain("\x1b[?1049l")

    expect(stdout.capturedOutput).not.toContain("\x1b[?1006l")
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(tmpPath) } catch {}
  }
})

test("writeSync(fd) path is fully synchronous: bytes are on disk before destroy() returns", async () => {
  const tmpPath = join(tmpdir(), `opentui-hard-restore-sync-${Date.now()}.txt`)
  let fd: number | null = null

  try {
    fd = openSync(tmpPath, "w")
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream
    const stdout = new FdWriteStream(fd)

    const renderer = new CliRenderer(stdin, stdout as unknown as NodeJS.WriteStream, 80, 24, {
      screenMode: "alternate-screen",
      consoleMode: "disabled",
      exitOnCtrlC: false,
      exitSignals: [],
      bufferedOutput: "memory",
    })

    await renderer.setupTerminal()
    // No await on destroy; no microtask yield. The whole point of the
    // writeSync(fd) path is that mode-disable bytes hit the kernel before
    // control returns to the caller, so subsequent synchronous file reads
    // already observe them.
    renderer.destroy()
    const contents = readFileSync(tmpPath, "utf-8")

    expect(contents).toContain("\x1b[?1006l")
    expect(contents).toContain("\x1b[?1049l")
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(tmpPath) } catch {}
  }
})

test("destroy() returns a promise that resolves after teardown", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const result = renderer.destroy()
  expect(result).toBeInstanceOf(Promise)
  await result
  // After the awaited destroy(), the hard restore must already be observable
  // in the recorded output.
  expect(stdout.output).toContain("\x1b[?1006l")
  expect(stdout.output).toContain("\x1b[?1049l")
})

test("renderer.closed resolves after destroy and remains the same promise", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const closedEarly = renderer.closed
  expect(closedEarly).toBeInstanceOf(Promise)

  // Should not be resolved yet — renderer is alive.
  const raceMarker = Symbol("not-yet")
  const race = await Promise.race([closedEarly.then(() => "resolved"), Promise.resolve(raceMarker)])
  expect(race).toBe(raceMarker)

  const destroyPromise = renderer.destroy()
  // destroy() returns the same promise identity as `closed`.
  expect(destroyPromise).toBe(renderer.closed)
  expect(destroyPromise).toBe(closedEarly)

  await destroyPromise

  // After completion, `closed` keeps returning a resolved promise (cached).
  await expect(renderer.closed).resolves.toBeUndefined()
})

test("renderer.closed waits for the async write callback on non-fd Writables", async () => {
  // Stream that defers its _write callback so we can observe whether `closed`
  // really gates on the flush.
  class SlowWriteStream extends Writable {
    public readonly isTTY = true
    public readonly columns = 80
    public readonly rows = 24
    public output = ""
    public lastCallback: ((err?: Error | null) => void) | null = null
    public deferredChunks: Array<{ chunk: string; cb: (err?: Error | null) => void }> = []

    override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const str = typeof chunk === "string" ? chunk : decoder.decode(chunk)
      this.output += str
      if (str.includes("\x1b[?1006l")) {
        // Defer the restore-write callback explicitly to test the gating.
        this.deferredChunks.push({ chunk: str, cb: callback })
        return
      }
      callback()
    }

    getColorDepth(): number {
      return 24
    }

    flushDeferred(): void {
      const pending = this.deferredChunks.splice(0)
      for (const { cb } of pending) cb()
    }
  }

  const stdout = new SlowWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  let closedResolved = false
  renderer.closed.then(() => {
    closedResolved = true
  })

  renderer.destroy()

  // Synchronously after destroy(), the restore bytes have been queued to the
  // stream (stdout.output contains them) but the write callback has NOT
  // fired yet. So `closed` must still be pending.
  expect(stdout.output).toContain("\x1b[?1006l")
  // Allow microtasks to run; closed should NOT resolve while the callback
  // is being held.
  await new Promise((resolve) => setImmediate(resolve))
  expect(closedResolved).toBe(false)

  // Release the deferred callback. `closed` should now resolve.
  stdout.flushDeferred()
  await renderer.closed
  expect(closedResolved).toBe(true)
})

test("destroy() called twice returns the same promise and does not double-write", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const first = renderer.destroy()
  const second = renderer.destroy()
  expect(first).toBe(second)

  await first
  const outputAfter = stdout.output

  const third = renderer.destroy()
  await third
  expect(stdout.output).toBe(outputAfter)
})

test("destroy() succeeds even when native suspendRenderer throws during active render", async () => {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
    setRawMode: (enabled: boolean) => NodeJS.ReadStream
  }
  stdin.setRawMode = () => stdin

  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const lib = (renderer as any).lib as { suspendRenderer: (rendererPtr: unknown) => void }
  const originalSuspendRenderer = lib.suspendRenderer
  lib.suspendRenderer = () => {
    throw new Error("simulated suspend failure")
  }

  try {
    let frameCallbackError: unknown = null
    renderer.setFrameCallback(async () => {
      try {
        // destroy() during an active frame triggers prepareDestroyDuringRender.
        // Even if the subsequent suspendRenderer throws, the hard restore must
        // have been written synchronously beforehand.
        renderer.destroy()
      } catch (e) {
        frameCallbackError = e
      }
    })

    renderer.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(frameCallbackError).toBe(null)
    expect(stdout.output).toContain("\x1b[?1006l")
    expect(stdout.output).toContain("\x1b[?1049l")

    // The renderer should still be able to finalize cleanly.
    await renderer.closed
  } finally {
    // Restore the singleton-lib method so subsequent tests in the same
    // process are not affected.
    lib.suspendRenderer = originalSuspendRenderer
  }
})

test("destroy event fires after native destroy", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const lib = (renderer as any).lib as { destroyRenderer: (rendererPtr: unknown) => void }
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)
  let nativeDestroyed = false
  let observedAtEvent = false

  lib.destroyRenderer = (rendererPtr: unknown) => {
    nativeDestroyed = true
    originalDestroyRenderer(rendererPtr)
  }

  try {
    renderer.once(CliRenderEvents.DESTROY, () => {
      observedAtEvent = nativeDestroyed
    })

    await renderer.destroy()
    expect(observedAtEvent).toBe(true)
  } finally {
    lib.destroyRenderer = originalDestroyRenderer
  }
})

test("closed resolves after destroy event", async () => {
  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen",
  })
  await renderer.setupTerminal()

  const order: string[] = []
  renderer.once(CliRenderEvents.DESTROY, () => order.push("event"))
  await renderer.destroy().then(() => order.push("closed"))
  expect(order).toEqual(["event", "closed"])
})
