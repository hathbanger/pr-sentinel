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
        labels: [{ name: "agent" }],
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
  trigger: {
    requireLabel: "agent",
    respondToMentions: true,
    respondToReplies: true,
    botName: "pr-sentinel",
  },
  fix: {
    mode: "propose_and_pr",
    confidenceThreshold: 0.7,
    createDraftPr: true,
    maxRetryCount: 2,
  },
}

function resetPayload() {
  ;(github.context as any).eventName = "pull_request"
  ;(github.context as any).payload = {
    action: "opened",
    repository: { default_branch: "main" },
    pull_request: {
      number: 42,
      title: "Add feature",
      body: "This adds a new feature",
      base: { ref: "main" },
      head: { ref: "feature-branch" },
      labels: [{ name: "agent" }],
    },
  }
}

describe("routeEvent", () => {
  beforeEach(resetPayload)

  describe("label gating", () => {
    it("routes PR with agent label to pr_review", () => {
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("pr_review")
      expect(result.context.pullRequest?.number).toBe(42)
    })

    it("skips PR without agent label", () => {
      ;(github.context as any).payload.pull_request.labels = []
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("noop")
    })

    it("triggers when agent label is added", () => {
      ;(github.context as any).payload.action = "labeled"
      ;(github.context as any).payload.label = { name: "agent" }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("pr_review")
    })

    it("ignores when non-agent label is added", () => {
      ;(github.context as any).payload.action = "labeled"
      ;(github.context as any).payload.label = { name: "bug" }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("noop")
    })

    it("routes PR synchronize with agent label to pr_review", () => {
      ;(github.context as any).payload.action = "synchronize"
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("pr_review")
    })
  })

  describe("issue routing", () => {
    it("routes issue with agent label to issue_fix", () => {
      ;(github.context as any).eventName = "issues"
      ;(github.context as any).payload = {
        action: "opened",
        repository: { default_branch: "main" },
        issue: {
          number: 10,
          title: "Bug report",
          body: "Something is broken",
          labels: [{ name: "agent" }],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("issue_fix")
      expect(result.context.issue?.number).toBe(10)
    })

    it("skips issue without agent label", () => {
      ;(github.context as any).eventName = "issues"
      ;(github.context as any).payload = {
        action: "opened",
        repository: { default_branch: "main" },
        issue: {
          number: 10,
          title: "Bug",
          body: "",
          labels: [{ name: "bug" }],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("noop")
    })

    it("triggers when agent label is added to issue", () => {
      ;(github.context as any).eventName = "issues"
      ;(github.context as any).payload = {
        action: "labeled",
        repository: { default_branch: "main" },
        label: { name: "agent" },
        issue: {
          number: 10,
          title: "Bug",
          body: "",
          labels: [{ name: "agent" }],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("issue_fix")
    })
  })

  describe("@mention routing", () => {
    it("triggers pr_review when @pr-sentinel mentioned on PR comment", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "Hey @pr-sentinel can you review this?", id: 1, author_association: "MEMBER" },
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
    })

    it("triggers issue_fix when @pr-sentinel mentioned on issue comment", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "@pr-sentinel fix this please", id: 1, author_association: "MEMBER" },
        issue: {
          number: 10,
          title: "Bug",
          body: "",
          labels: [],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("issue_fix")
    })
  })

  describe("review comment replies", () => {
    it("routes reply to review comment as respond action", () => {
      ;(github.context as any).eventName = "pull_request_review_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: {
          body: "What about edge cases?",
          id: 100,
          in_reply_to_id: 99,
          author_association: "COLLABORATOR",
        },
        pull_request: {
          number: 42,
          title: "PR",
          body: "",
          base: { ref: "main" },
          head: { ref: "feature" },
          labels: [{ name: "agent" }],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("respond")
      expect(result.responseContext?.isPRReviewComment).toBe(true)
      expect(result.responseContext?.replyBody).toBe("What about edge cases?")
    })

    it("routes @mention in review comment as pr_review", () => {
      ;(github.context as any).eventName = "pull_request_review_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: {
          body: "@pr-sentinel re-review this file",
          id: 100,
          author_association: "MEMBER",
        },
        pull_request: {
          number: 42,
          title: "PR",
          body: "",
          base: { ref: "main" },
          head: { ref: "feature" },
          labels: [],
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("pr_review")
    })
  })

  describe("slash commands", () => {
    it("parses /bot review on PR", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "/bot review", id: 1, author_association: "OWNER" },
        issue: {
          number: 42,
          title: "PR",
          body: "",
          labels: [],
          pull_request: { url: "..." },
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("pr_review")
      expect(result.slashCommand?.command).toBe("review")
    })

    it("parses /bot fix on issue", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "/bot fix", id: 1, author_association: "MEMBER" },
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
    })

    it("rejects slash commands from untrusted actors", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "/bot review", id: 1, author_association: "NONE" },
        issue: {
          number: 42,
          title: "PR",
          body: "",
          labels: [],
          pull_request: { url: "..." },
        },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("noop")
    })

    it("ignores non-slash non-mention comments", () => {
      ;(github.context as any).eventName = "issue_comment"
      ;(github.context as any).payload = {
        action: "created",
        repository: { default_branch: "main" },
        comment: { body: "Looks good to me!", id: 1 },
        issue: { number: 42, title: "PR", body: "", labels: [] },
      }
      const result = routeEvent(defaultPolicies)
      expect(result.actionType).toBe("noop")
    })
  })
})
