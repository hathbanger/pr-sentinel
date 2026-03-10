import { describe, it, expect, vi } from "vitest"

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}))

import { orchestrateReview } from "../src/orchestrator"
import type { ReviewContext, ModelReview, RepoPolicies } from "../src/types"
import type { ModelClient } from "../src/models/types"

function makeContext(overrides?: Partial<ReviewContext>): ReviewContext {
  return {
    repository: { owner: "test", name: "repo", defaultBranch: "main" },
    event: { type: "pull_request", action: "opened", actor: "dev", trustedActor: true },
    pullRequest: {
      number: 1,
      title: "Add feature",
      body: "New feature",
      baseRef: "main",
      headRef: "feature",
      labels: [],
      changedFiles: [
        { path: "src/index.ts", patch: "+console.log('hi')", status: "modified", additions: 1, deletions: 0 },
      ],
    },
    repoPolicies: {
      mode: "review",
      autoFixEnabled: false,
      restrictedPaths: [],
      testCommands: [],
      maxFiles: 50,
      maxPatchChars: 200_000,
      severityThreshold: "medium",
      blockForkMutation: true,
      inlineComments: true,
      commentStyle: "comprehensive",
      models: {
        anthropic: { enabled: true, model: "claude-sonnet-4-20250514" },
        openai: { enabled: true, model: "gpt-4o" },
      },
    },
    ...overrides,
  }
}

function makeReview(overrides?: Partial<ModelReview>): ModelReview {
  return {
    summary: "Looks good",
    severity: "low",
    confidence: 0.9,
    findings: [],
    mergeBlocking: false,
    needsHumanAttention: false,
    ...overrides,
  }
}

function makeMockClient(
  name: "anthropic" | "openai",
  review: ModelReview
): ModelClient {
  return {
    name,
    review: vi.fn().mockResolvedValue({ review, usage: { input: 100, output: 50 } }),
    critique: vi.fn().mockResolvedValue({
      critique: {
        agreedFindings: [],
        disputedFindings: [],
        missedIssues: [],
        overallAssessment: "Looks fine",
        revisedSeverity: "low",
      },
      usage: { input: 80, output: 40 },
    }),
    respondToCritique: vi.fn().mockResolvedValue({
      response: {
        accepted: [],
        disputed: [],
        revisedFindings: review.findings,
        finalSummary: "No changes",
      },
      usage: { input: 80, output: 40 },
    }),
  }
}

describe("orchestrateReview", () => {
  it("runs dual-model review with no findings", async () => {
    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", makeReview())
    const openai = makeMockClient("openai", makeReview())

    const result = await orchestrateReview(ctx, anthropic, openai)

    expect(result.action).toBe("comment_only")
    expect(result.findings).toHaveLength(0)
    expect(result.tokenUsage.anthropic.input).toBeGreaterThan(0)
    expect(result.tokenUsage.openai.input).toBeGreaterThan(0)
    expect(anthropic.review).toHaveBeenCalledOnce()
    expect(openai.review).toHaveBeenCalledOnce()
    expect(anthropic.critique).toHaveBeenCalledOnce()
    expect(openai.respondToCritique).toHaveBeenCalledOnce()
  })

  it("requests changes on high severity findings", async () => {
    const anthropicReview = makeReview({
      severity: "high",
      findings: [
        {
          type: "bug",
          severity: "high",
          title: "Null deref",
          file: "src/index.ts",
          lineStart: 10,
          explanation: "Possible null dereference",
          confidence: 0.9,
          source: "anthropic",
        },
      ],
      mergeBlocking: true,
    })

    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", anthropicReview)
    const openai = makeMockClient("openai", makeReview())

    const result = await orchestrateReview(ctx, anthropic, openai)

    expect(result.action).toBe("request_changes")
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it("falls back to single model when one fails", async () => {
    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", makeReview({ summary: "Solo review" }))

    const result = await orchestrateReview(ctx, anthropic, null)

    expect(result.action).toBe("comment_only")
    expect(result.rationale).toContain("Single-model")
    expect(result.rationale).toContain("anthropic")
  })

  it("returns decline when both models are null", async () => {
    const ctx = makeContext()
    const result = await orchestrateReview(ctx, null, null)

    expect(result.action).toBe("decline")
    expect(result.rationale).toContain("unavailable")
  })

  it("handles anthropic review failure gracefully", async () => {
    const ctx = makeContext()
    const anthropic: ModelClient = {
      name: "anthropic",
      review: vi.fn().mockRejectedValue(new Error("rate limited")),
      critique: vi.fn(),
      respondToCritique: vi.fn(),
    }
    const openai = makeMockClient("openai", makeReview({ summary: "OpenAI solo" }))

    const result = await orchestrateReview(ctx, anthropic, openai)

    expect(result.action).toBe("comment_only")
    expect(result.rationale).toContain("Single-model")
    expect(result.rationale).toContain("openai")
  })

  it("deduplicates findings from both models", async () => {
    const sharedFinding = {
      type: "bug" as const,
      severity: "medium" as const,
      title: "Missing null check",
      file: "src/index.ts",
      lineStart: 5,
      explanation: "Could be null",
      confidence: 0.8,
    }

    const anthropicReview = makeReview({
      findings: [{ ...sharedFinding, source: "anthropic" as const }],
    })
    const openaiReview = makeReview({
      findings: [{ ...sharedFinding, source: "openai" as const }],
    })

    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", anthropicReview)
    const openai = makeMockClient("openai", openaiReview)

    const result = await orchestrateReview(ctx, anthropic, openai)

    const nullCheckFindings = result.findings.filter((f) => f.title === "Missing null check")
    expect(nullCheckFindings).toHaveLength(1)
  })

  it("tracks token usage across all phases", async () => {
    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", makeReview())
    const openai = makeMockClient("openai", makeReview())

    const result = await orchestrateReview(ctx, anthropic, openai)

    expect(result.tokenUsage.anthropic.input).toBe(180)
    expect(result.tokenUsage.anthropic.output).toBe(90)
    expect(result.tokenUsage.openai.input).toBe(180)
    expect(result.tokenUsage.openai.output).toBe(90)
  })

  it("measures duration", async () => {
    const ctx = makeContext()
    const anthropic = makeMockClient("anthropic", makeReview())
    const openai = makeMockClient("openai", makeReview())

    const result = await orchestrateReview(ctx, anthropic, openai)

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(5000)
  })
})
