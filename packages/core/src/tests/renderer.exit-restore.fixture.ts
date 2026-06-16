// Fixture for verifying that OpenTUI restores terminal modes via its
// `process.on("exit")` handler even when the host application never calls
// renderer.destroy() — e.g. an explicit process.exit from arbitrary
// application code, or a real uncaughtException crash (after the host
// removes OpenTUI's swallowing listener).
//
// CLI: <fixturePath> <tmpStdoutPath> <exitMode>
//   tmpStdoutPath: a file path the fixture will open as stdout (must be writable).
//   exitMode: one of "exit", "host-uncaught".
import { openSync, closeSync, writeSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { CliRenderer } from "../renderer.js"

const tmpStdoutPath = process.argv[2]
const exitMode = process.argv[3] ?? "exit"

if (!tmpStdoutPath) {
  console.error("missing tmpStdoutPath")
  process.exit(2)
}

const fd = openSync(tmpStdoutPath, "w")

class FdStream extends Writable {
  public readonly isTTY = true
  public columns = 80
  public rows = 24
  public readonly fd: number
  constructor(fd: number) {
    super()
    this.fd = fd
  }
  override _write(_chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    cb()
  }
  getColorDepth(): number {
    return 24
  }
}

const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
  setRawMode: (enabled: boolean) => NodeJS.ReadStream
}
stdin.setRawMode = (enabled) => {
  if (!enabled) {
    writeSync(fd, "RAW_MODE_FALSE\n")
  }
  return stdin
}

const stdout = new FdStream(fd)

const renderer = new CliRenderer(stdin, stdout as unknown as NodeJS.WriteStream, 80, 24, {
  screenMode: "alternate-screen",
  consoleMode: "disabled",
  exitOnCtrlC: false,
  exitSignals: [],
})

await renderer.setupTerminal()

// IMPORTANT: do NOT call renderer.destroy() and do NOT register an `exit`
// handler that calls it. The whole point of this fixture is to verify
// OpenTUI's internal process.on("exit") handler restores the terminal
// without any application-level cooperation.

if (exitMode === "host-uncaught") {
  // Remove every uncaughtException listener (including the one OpenTUI
  // registered to suppress Node's default crash behavior). This simulates
  // a host application that wants exceptions to actually crash the process.
  process.removeAllListeners("uncaughtException")
  setImmediate(() => {
    throw new Error("simulated uncaught exception")
  })
} else {
  // Direct process.exit without calling renderer.destroy(). The exit
  // handler installed by OpenTUI must do the restore.
  process.exit(0)
}

// Best-effort close on graceful paths; the kernel will close on exit anyway.
process.on("exit", () => {
  try {
    closeSync(fd)
  } catch {
    // ignore
  }
})
