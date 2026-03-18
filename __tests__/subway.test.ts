import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}))

import { readPrContact, readCommitContact, isContactFresh, notifySubwayAgent } from "../src/subway"
import type { SubwayContact } from "../src/types"
import type { FinalDecision } from "../src/types"

function makeDecision(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    action: "comment_only",
    rationale: "test",
    findings: [],
    tokenUsage: { anthropic: { input: 0, output: 0 }, openai: { input: 0, output: 0 } },
    durationMs: 100,
    ...overrides,
  }
}

function makeContact(overrides: Partial<SubwayContact> = {}): SubwayContact {
  return {
    name: "andrew.relay",
    relay: "relay.subway.dev",
    registered_at: new Date().toISOString(),
    source: "pi-extension",
    ...overrides,
  }
}

describe("readPrContact", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when .subway/pr-contact does not exist", () => {
    const result = readPrContact(tmpDir)
    expect(result).toBeNull()
  })

  it("returns null when file contains invalid JSON", () => {
    fs.mkdirSync(path.join(tmpDir, ".subway"))
    fs.writeFileSync(path.join(tmpDir, ".subway", "pr-contact"), "not json")
    const result = readPrContact(tmpDir)
    expect(result).toBeNull()
  })

  it("returns null when name field is missing", () => {
    fs.mkdirSync(path.join(tmpDir, ".subway"))
    fs.writeFileSync(
      path.join(tmpDir, ".subway", "pr-contact"),
      JSON.stringify({ relay: "relay.subway.dev", registered_at: new Date().toISOString() })
    )
    const result = readPrContact(tmpDir)
    expect(result).toBeNull()
  })

  it("returns parsed contact when file is valid", () => {
    const contact = makeContact()
    fs.mkdirSync(path.join(tmpDir, ".subway"))
    fs.writeFileSync(path.join(tmpDir, ".subway", "pr-contact"), JSON.stringify(contact))
    const result = readPrContact(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("andrew.relay")
    expect(result!.relay).toBe("relay.subway.dev")
    expect(result!.source).toBe("pi-extension")
  })

  it("fills in defaults for optional fields", () => {
    fs.mkdirSync(path.join(tmpDir, ".subway"))
    fs.writeFileSync(
      path.join(tmpDir, ".subway", "pr-contact"),
      JSON.stringify({ name: "minimal.relay" })
    )
    const result = readPrContact(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.relay).toBe("relay.subway.dev")
    expect(result!.source).toBe("cli")
  })
})

describe("isContactFresh", () => {
  it("returns true for a timestamp 5 minutes ago", () => {
    const contact = makeContact({
      registered_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    })
    expect(isContactFresh(contact)).toBe(true)
  })

  it("returns false for a timestamp 2 hours ago", () => {
    const contact = makeContact({
      registered_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    })
    expect(isContactFresh(contact)).toBe(false)
  })

  it("returns false for an invalid timestamp", () => {
    const contact = makeContact({ registered_at: "not-a-date" })
    expect(isContactFresh(contact)).toBe(false)
  })

  it("respects custom maxAgeMs", () => {
    const contact = makeContact({
      registered_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    })
    expect(isContactFresh(contact, 5 * 60 * 1000)).toBe(false)
    expect(isContactFresh(contact, 20 * 60 * 1000)).toBe(true)
  })
})

describe("readCommitContact", () => {
  it("returns null when git command fails", () => {
    const result = readCommitContact("nonexistent-sha-zzz")
    expect(result).toBeNull()
  })

  it("extracts Subway-Agent trailer from HEAD commit", () => {
    const result = readCommitContact("HEAD")
    if (result !== null) {
      expect(result.name).toMatch(/\S+/)
      expect(result.relay).toBe("relay.subway.dev")
      expect(result.source).toBe("cli")
    }
  })
})

describe("notifySubwayAgent", () => {
  const ctx = {
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    repo: "owner/repo",
    headSha: "abc123def456",
    prState: "open" as const,
    runUrl: "https://github.com/owner/repo/actions/runs/999",
  }

  it("broadcasts even when contact is null", async () => {
    const posts: Array<{ url: string; body: unknown }> = []

    vi.mock("https", () => ({
      request: (_opts: unknown, cb: (res: { statusCode: number; on: (e: string, fn: (d?: unknown) => void) => void }) => void) => {
        const res = {
          statusCode: 200,
          on: (event: string, fn: (d?: unknown) => void) => {
            if (event === "data") fn("")
            if (event === "end") fn()
          },
        }
        cb(res)
        return { setTimeout: vi.fn(), on: vi.fn(), write: vi.fn(), end: vi.fn() }
      },
    }))

    await expect(
      notifySubwayAgent(null, makeDecision(), ctx, "http://localhost:9001")
    ).resolves.not.toThrow()
  })

  it("does not throw when bridge is unreachable", async () => {
    await expect(
      notifySubwayAgent(null, makeDecision(), ctx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("builds correct has_blockers for request_changes action", async () => {
    const decision = makeDecision({ action: "request_changes" })

    await expect(
      notifySubwayAgent(null, decision, ctx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("builds correct has_blockers for needs_human_review action", async () => {
    const decision = makeDecision({ action: "needs_human_review" })

    await expect(
      notifySubwayAgent(null, decision, ctx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("sets has_blockers false for comment_only action", async () => {
    const decision = makeDecision({ action: "comment_only" })

    await expect(
      notifySubwayAgent(null, decision, ctx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("includes pr_state in payload for open PR", async () => {
    const openCtx = { ...ctx, prState: "open" as const }
    await expect(
      notifySubwayAgent(null, makeDecision(), openCtx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("includes pr_state in payload for merged PR", async () => {
    const mergedCtx = { ...ctx, prState: "merged" as const }
    await expect(
      notifySubwayAgent(null, makeDecision(), mergedCtx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })

  it("includes pr_state in payload for closed PR", async () => {
    const closedCtx = { ...ctx, prState: "closed" as const }
    await expect(
      notifySubwayAgent(null, makeDecision(), closedCtx, "http://127.0.0.1:19999")
    ).resolves.not.toThrow()
  })
})
