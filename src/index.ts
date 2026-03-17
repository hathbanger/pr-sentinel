import * as core from "@actions/core"
import * as github from "@actions/github"
import { routeEvent } from "./router"
import { buildPRContext, buildIssueContext } from "./context"
import { loadPolicies, evaluateTrust } from "./policy"
import { orchestrateReview } from "./orchestrator"
import { reportReview, reportIssueTriage, reportFailure, reportFixResult } from "./reporter"
import { fixIssue } from "./fixer"
import { handleResponse } from "./responder"
import { AnthropicClient } from "./models/anthropic"
import { OpenAIClient } from "./models/openai"
import { OpenRouterClient } from "./models/openrouter"
import type { ModelClient } from "./models/types"

async function run(): Promise<void> {
  const start = Date.now()

  try {
    const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN || ""
    const anthropicKey = core.getInput("anthropic_api_key")
    const openaiKey = core.getInput("openai_api_key")
    const openrouterKey = core.getInput("openrouter_api_key")
    const configPath = core.getInput("config_path") || ".github/sentinel.yml"
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
    } else if (openrouterKey && policies.models.anthropic.enabled) {
      const model = core.getInput("openrouter_anthropic_model") || "anthropic/claude-sonnet-4-20250514"
      anthropic = new OpenRouterClient(openrouterKey, model, "anthropic")
      core.info(`Anthropic slot: using OpenRouter fallback (${model})`)
    } else {
      core.warning("Anthropic disabled or no API key (no OpenRouter fallback)")
    }

    if (openaiKey && policies.models.openai.enabled) {
      openai = new OpenAIClient(openaiKey, policies.models.openai.model)
    } else if (openrouterKey && policies.models.openai.enabled) {
      const model = core.getInput("openrouter_openai_model") || "openai/gpt-4o"
      openai = new OpenRouterClient(openrouterKey, model, "openai")
      core.info(`OpenAI slot: using OpenRouter fallback (${model})`)
    } else {
      core.warning("OpenAI disabled or no API key (no OpenRouter fallback)")
    }

    if (!anthropic && !openai) {
      core.setFailed("At least one model must be configured (anthropic_api_key, openai_api_key, or openrouter_api_key)")
      return
    }

    switch (routed.actionType) {
      case "pr_review": {
        await handlePRReview(octokit, routed.context, anthropic, openai, debug)
        break
      }
      case "issue_fix": {
        await handleIssueFix(octokit, routed.context, anthropic, openai, debug)
        break
      }
      case "issue_triage": {
        await handleIssueTriage(octokit, routed.context)
        break
      }
      case "respond": {
        if (routed.responseContext) {
          const model = anthropic || openai!
          await handleResponse(routed.context, routed.responseContext, model, octokit)
        }
        break
      }
      case "pr_fix": {
        core.info("PR fix mode not yet implemented (Phase 2)")
        break
      }
      case "slash_command": {
        const cmd = routed.slashCommand
        if (cmd?.command === "fix") {
          if (cmd.isPR) {
            core.info("PR fix via slash command not yet implemented")
          } else {
            await handleIssueFix(octokit, routed.context, anthropic, openai, debug)
          }
        } else if (cmd?.command === "review" && cmd.isPR) {
          await handlePRReview(octokit, routed.context, anthropic, openai, debug)
        } else {
          core.info(`Slash command /bot ${cmd?.command} — not yet implemented`)
        }
        break
      }
    }

    core.info(`Sentinel completed in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    core.setFailed(`Sentinel failed: ${err instanceof Error ? err.message : String(err)}`)

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

async function handleIssueFix(
  octokit: ReturnType<typeof github.getOctokit>,
  ctx: import("./types").ReviewContext,
  anthropic: ModelClient | null,
  openai: ModelClient | null,
  debug: boolean
): Promise<void> {
  if (!ctx.issue) {
    core.warning("No issue context available")
    return
  }

  ctx = await buildIssueContext(ctx, octokit)

  if (debug) {
    core.info(`Fixing issue #${ctx.issue!.number}: ${ctx.issue!.title}`)
  }

  const { mode, confidenceThreshold } = ctx.repoPolicies.fix

  const trust = evaluateTrust({
    actor: ctx.event.actor,
    isFork: ctx.event.isFork,
    policies: ctx.repoPolicies,
  })

  const effectiveMode = trust.canMutate ? mode : "propose_only" as const
  if (effectiveMode !== mode) {
    core.info(`Mutation blocked: ${trust.reason}. Mode downgraded to propose_only.`)
  }

  const result = await fixIssue(ctx, anthropic, openai, octokit, effectiveMode, confidenceThreshold)

  await reportFixResult(octokit, ctx.issue!.number, result, mode)

  if (result.success) {
    core.info(`Fix ${mode === "propose_only" ? "proposed" : "applied"} for issue #${ctx.issue!.number}`)
  } else {
    core.warning(`Fix failed for issue #${ctx.issue!.number}: ${result.error}`)
  }
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

  core.info(`Issue #${ctx.issue!.number} triage: routing to fix flow`)
}

run()
