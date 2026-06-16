import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const testFilePath = fileURLToPath(import.meta.url)
const testDir = dirname(testFilePath)
const fixturePath = join(testDir, `renderer.exit-restore.fixture${extname(testFilePath)}`)
const packageRoot = testFilePath.includes(`${sep}.node-test${sep}`)
  ? resolve(testDir, "..", "..", "..")
  : resolve(testDir, "..", "..")
const workspaceRoot = resolve(packageRoot, "..", "..")

function getFixtureRuntimeArgs(): string[] {
  if (process.versions.bun) {
    return []
  }
  return [
    "--permission",
    `--allow-fs-read=${workspaceRoot}`,
    `--allow-fs-write=${tmpdir()}`,
    "--allow-child-process",
    "--allow-worker",
    "--allow-ffi",
    "--experimental-ffi",
  ]
}

function runFixture(exitMode: "exit" | "host-uncaught"): { exitCode: number | null; stdoutFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "opentui-exit-restore-"))
  const stdoutPath = join(dir, "stdout.bin")
  try {
    const result = spawnSync(process.execPath, [...getFixtureRuntimeArgs(), fixturePath, stdoutPath, exitMode], {
      cwd: packageRoot,
      env: process.env,
      timeout: 5000,
    })
    const contents = readFileSync(stdoutPath, "utf-8")
    return { exitCode: result.status, stdoutFile: contents }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

describe("OpenTUI process.on('exit') terminal restore", () => {
  it("restores terminal on explicit process.exit() without renderer.destroy()", () => {
    const { exitCode, stdoutFile } = runFixture("exit")
    expect(exitCode).toBe(0)
    expect(stdoutFile).toContain("RAW_MODE_FALSE")
    expect(stdoutFile).toContain("\x1b[?1006l")
    expect(stdoutFile).toContain("\x1b[?1003l")
    expect(stdoutFile).toContain("\x1b[?1049l")
    expect(stdoutFile).toContain("\x1b[<u")
  })

  it("restores terminal when host removes OpenTUI's uncaughtException handler and the process crashes", () => {
    // OpenTUI registers its own uncaughtException listener that suppresses
    // Node's default crash behavior, so a bare `throw` would otherwise be
    // swallowed. A host application that wants Node's default behavior must
    // remove OpenTUI's listener — in which case the process really does
    // crash, fires `process.on("exit")`, and our last-resort restore runs.
    const { exitCode, stdoutFile } = runFixture("host-uncaught")
    expect(exitCode).not.toBe(0)
    expect(stdoutFile).toContain("RAW_MODE_FALSE")
    expect(stdoutFile).toContain("\x1b[?1006l")
    expect(stdoutFile).toContain("\x1b[?1049l")
  })
})
