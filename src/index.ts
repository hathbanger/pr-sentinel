import * as core from "@actions/core"
import * as github from "@actions/github"
import { routeEvent } from "./router"
import { buildPRContext, buildIssueContext } from "./context"
import { loadPolicies } from "./policy"
import { orchestrateReview } from "./orchestrator"
import { reportReview, reportIssueTriage, reportFailure } from "./reporter"
import { AnthropicClient } from "./models/anthropic"
import { OpenAIClient } from "./models/openai"
import type { ModelClient } from "./models/types"

async function run(): Promise<void> {
  const start = Date.now()

  try {
    const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN || ""
    const anthropicKey = core.getInput("anthropic_api_key")
    const openaiKey = core.getInput("openai_api_key")
    const configPath = core.getInput("config_path") || ".github/pr-sentinel.yml"
    const modeOverride = core.getInput("mode") || undefined
    const debug = core.getInput("debug") === "true"

    if (debug) core.info(`Event: ${github.context.eventName} / ${github.context.payload.action}`)

    if (!githubToken) {
      core.setFailed("github_token is required")
      return
    }

    const octokit = github.getOctokit(githubToken)
    const policies = await loadPolicies(octokit, configPath, modeOverride)
    const routed = routeEvent(policies)

    if (debug) core.info(`Routed to: ${routed.actionType}`)

    if (routed.actionType === "noop") {
      core.info("No action required for this event")
      return
    }

    let anthropic: ModelClient | null = null
    let openai: ModelClient | null = null

    if (anthropicKey && policies.models.anthropic.enabled) {
      anthropic = new AnthropicClient(anthropicKey, policies.models.anthropic.model)
    } else {
      core.warning("Anthropic disabled or no API key — running without architecture review")
    }

    if (openaiKey && policies.models.openai.enabled) {
      openai = new OpenAIClient(openaiKey, policies.models.openai.model)
    } else {
      core.warning("OpenAI disabled or no API key — running without implementation review")
    }

    if (!anthropic && !openai) {
      core.setFailed("At least one model must be configured (anthropic_api_key or openai_api_key)")
      return
    }

    switch (routed.actionType) {
      case "pr_review": {
        await handlePRReview(octokit, routed.context, anthropic, openai, debug)
        break
      }
      case "issue_triage": {
        await handleIssueTriage(octokit, routed.context)
        break
      }
      case "pr_fix":
      case "issue_fix": {
        core.info(`${routed.actionType} is not yet implemented (Phase 2+)`)
        break
      }
      case "slash_command": {
        const cmd = routed.slashCommand
        core.info(`Slash command received: /bot ${cmd?.command} (Phase 1+)`)
        break
      }
    }

    core.info(`PR Sentinel completed in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    core.setFailed(`PR Sentinel failed: ${err instanceof Error ? err.message : String(err)}`)

    try {
      const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN || ""
      if (githubToken) {
        const octokit = github.getOctokit(githubToken)
        const prNumber = github.context.payload.pull_request?.number
          || github.context.payload.issue?.number
        if (prNumber) {
          await reportFailure(octokit, prNumber, err instanceof Error ? err.message : String(err))
        }
      }
    } catch {
      core.debug("Could not post failure comment")
    }
  }
}

async function handlePRReview(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: import("./types").ReviewContext,
  anthropic: ModelClient | null,
  openai: ModelClient | null,
  debug: boolean
): Promise<void> {
  if (!ctx.pullRequest) {
    core.warning("No PR context available")
    return
  }

  ctx = await buildPRContext(ctx, octokit)

  if (ctx.pullRequest!.changedFiles.length === 0) {
    core.info("No changed files to review")
    return
  }

  if (debug) {
    core.info(`Reviewing PR #${ctx.pullRequest!.number}: ${ctx.pullRequest!.changedFiles.length} files`)
  }

  const decision = await orchestrateReview(ctx, anthropic, openai)

  if (debug) {
    core.info(`Decision: ${decision.action}, ${decision.findings.length} findings, ${decision.durationMs}ms`)
  }

  await reportReview(octokit, decision, ctx.pullRequest!.number)
}

async function handleIssueTriage(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: import("./types").ReviewContext
): Promise<void> {
  if (!ctx.issue) {
    core.warning("No issue context available")
    return
  }

  ctx = await buildIssueContext(ctx, octokit)

  core.info(`Issue #${ctx.issue!.number} triage: not yet implemented (Phase 0.5)`)
  core.info(`Title: ${ctx.issue!.title}`)
  core.info(`Labels: ${ctx.issue!.labels.join(", ") || "none"}`)
}

run()
