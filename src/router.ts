import * as core from "@actions/core"
import * as github from "@actions/github"
import type { ActionType, EventType, SlashCommand, RoutedEvent, ReviewContext, RepoPolicies } from "./types"

const SLASH_COMMANDS = ["review", "fix", "triage", "plan", "explain", "retry", "ignore", "security-review", "tests"]

export function routeEvent(policies: RepoPolicies): RoutedEvent {
  const { context } = github
  const eventName = context.eventName
  const action = context.payload.action || ""
  const actor = context.actor

  core.info(`Routing event: ${eventName} / ${action} from ${actor}`)

  const baseContext: ReviewContext = {
    repository: {
      owner: context.repo.owner,
      name: context.repo.repo,
      defaultBranch: context.payload.repository?.default_branch || "main",
    },
    event: {
      type: mapEventType(eventName),
      action,
      actor,
      trustedActor: false,
    },
    repoPolicies: policies,
  }

  if (eventName === "pull_request") {
    return routePullRequest(baseContext, action)
  }

  if (eventName === "issues") {
    return routeIssue(baseContext, action)
  }

  if (eventName === "issue_comment") {
    return routeComment(baseContext)
  }

  if (eventName === "workflow_dispatch") {
    return { actionType: "pr_review", context: baseContext }
  }

  core.info(`Unhandled event: ${eventName}`)
  return { actionType: "noop", context: baseContext }
}

function routePullRequest(ctx: ReviewContext, action: string): RoutedEvent {
  if (["opened", "synchronize", "reopened"].includes(action)) {
    const pr = github.context.payload.pull_request
    if (pr) {
      ctx.pullRequest = {
        number: pr.number,
        title: pr.title || "",
        body: pr.body || "",
        baseRef: pr.base?.ref || "main",
        headRef: pr.head?.ref || "",
        labels: (pr.labels || []).map((l: { name: string }) => l.name),
        changedFiles: [],
      }
    }
    return { actionType: "pr_review", context: ctx }
  }

  return { actionType: "noop", context: ctx }
}

function routeIssue(ctx: ReviewContext, action: string): RoutedEvent {
  if (action === "opened") {
    const issue = github.context.payload.issue
    if (issue) {
      ctx.issue = {
        number: issue.number,
        title: issue.title || "",
        body: issue.body || "",
        labels: (issue.labels || []).map((l: { name: string }) => l.name),
      }
    }
    return { actionType: "issue_triage", context: ctx }
  }

  return { actionType: "noop", context: ctx }
}

function routeComment(ctx: ReviewContext): RoutedEvent {
  const comment = github.context.payload.comment
  const issue = github.context.payload.issue
  if (!comment || !issue) return { actionType: "noop", context: ctx }

  const body = (comment.body || "").trim()
  const isPR = !!issue.pull_request

  const slashCommand = parseSlashCommand(body, ctx.event.actor, issue.number, isPR)
  if (slashCommand) {
    const actionType = resolveCommandAction(slashCommand, isPR)
    if (isPR) {
      ctx.pullRequest = {
        number: issue.number,
        title: issue.title || "",
        body: issue.body || "",
        baseRef: "",
        headRef: "",
        labels: (issue.labels || []).map((l: { name: string }) => l.name),
        changedFiles: [],
      }
    } else {
      ctx.issue = {
        number: issue.number,
        title: issue.title || "",
        body: issue.body || "",
        labels: (issue.labels || []).map((l: { name: string }) => l.name),
      }
    }
    return { actionType, context: ctx, slashCommand }
  }

  return { actionType: "noop", context: ctx }
}

function parseSlashCommand(body: string, actor: string, issueNumber: number, isPR: boolean): SlashCommand | undefined {
  const match = body.match(/^\/bot\s+(\S+)(.*)$/m)
  if (!match) return undefined

  const command = match[1].toLowerCase()
  if (!SLASH_COMMANDS.includes(command)) return undefined

  const args = match[2].trim().split(/\s+/).filter(Boolean)
  return { command, args, actor, issueNumber, isPR }
}

function resolveCommandAction(cmd: SlashCommand, isPR: boolean): ActionType {
  switch (cmd.command) {
    case "review":
      return isPR ? "pr_review" : "noop"
    case "fix":
      return isPR ? "pr_fix" : "issue_fix"
    case "triage":
      return "issue_triage"
    case "plan":
    case "explain":
      return isPR ? "pr_review" : "issue_triage"
    case "security-review":
    case "tests":
      return isPR ? "pr_review" : "noop"
    case "ignore":
    case "retry":
    default:
      return "noop"
  }
}

function mapEventType(eventName: string): EventType {
  if (eventName === "pull_request") return "pull_request"
  if (eventName === "issues") return "issue"
  if (eventName === "issue_comment") return "issue_comment"
  return "issue_comment"
}
