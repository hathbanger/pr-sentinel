import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  getInput: vi.fn(() => ""),
}))

vi.mock("@actions/github", () => ({
  context: {
    eventName: "pull_request",
    actor: "test-user",
    payload: {
      action: "opened",
      repository: { default_branch: "main" },
      pull_request: {
        number: 42,
        title: "Add feature",
        body: "This adds a new feature",
        base: { ref: "main" },
        head: { ref: "feature-branch" },
        labels: [],
      },
    },
    repo: { owner: "test-owner", repo: "test-repo" },
  },
}))

import * as github from "@actions/github"
import { routeEvent } from "../src/router"
import type { RepoPolicies } from "../src/types"

const defaultPolicies: RepoPolicies = {
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
}

describe("routeEvent", () => {
  it("routes pull_request opened to pr_review", () => {
    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("pr_review")
    expect(result.context.pullRequest?.number).toBe(42)
    expect(result.context.pullRequest?.title).toBe("Add feature")
  })

  it("routes pull_request synchronize to pr_review", () => {
    ;(github.context as any).payload.action = "synchronize"
    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("pr_review")
  })

  it("routes unhandled action to noop", () => {
    ;(github.context as any).payload.action = "labeled"
    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("noop")
  })

  it("routes issue opened to issue_triage", () => {
    ;(github.context as any).eventName = "issues"
    ;(github.context as any).payload = {
      action: "opened",
      repository: { default_branch: "main" },
      issue: {
        number: 10,
        title: "Bug report",
        body: "Something is broken",
        labels: [{ name: "bug" }],
      },
    }

    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("issue_triage")
    expect(result.context.issue?.number).toBe(10)
    expect(result.context.issue?.title).toBe("Bug report")
  })

  it("parses /bot review slash command on PR comment", () => {
    ;(github.context as any).eventName = "issue_comment"
    ;(github.context as any).payload = {
      action: "created",
      repository: { default_branch: "main" },
      comment: { body: "/bot review" },
      issue: {
        number: 42,
        title: "Some PR",
        body: "",
        labels: [],
        pull_request: { url: "https://api.github.com/..." },
      },
    }

    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("pr_review")
    expect(result.slashCommand?.command).toBe("review")
    expect(result.slashCommand?.isPR).toBe(true)
  })

  it("parses /bot fix slash command on issue comment", () => {
    ;(github.context as any).eventName = "issue_comment"
    ;(github.context as any).payload = {
      action: "created",
      repository: { default_branch: "main" },
      comment: { body: "/bot fix please" },
      issue: {
        number: 10,
        title: "Bug",
        body: "",
        labels: [],
      },
    }

    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("issue_fix")
    expect(result.slashCommand?.command).toBe("fix")
    expect(result.slashCommand?.isPR).toBe(false)
  })

  it("ignores non-slash comments", () => {
    ;(github.context as any).eventName = "issue_comment"
    ;(github.context as any).payload = {
      action: "created",
      repository: { default_branch: "main" },
      comment: { body: "Looks good to me!" },
      issue: { number: 42, title: "PR", body: "", labels: [] },
    }

    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("noop")
  })

  it("ignores unknown slash commands", () => {
    ;(github.context as any).eventName = "issue_comment"
    ;(github.context as any).payload = {
      action: "created",
      repository: { default_branch: "main" },
      comment: { body: "/bot deploy" },
      issue: { number: 42, title: "PR", body: "", labels: [] },
    }

    const result = routeEvent(defaultPolicies)
    expect(result.actionType).toBe("noop")
  })
})
