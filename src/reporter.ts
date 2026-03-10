import * as core from "@actions/core"
import * as github from "@actions/github"
import type { FinalDecision, FinalAction, ReviewFinding, FindingSeverity, FindingType } from "./types"

type Octokit = ReturnType<typeof github.getOctokit>

const COMMENT_MARKER = "<!-- pr-sentinel-review -->"

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: "🔴",
  high: "🔴",
  medium: "🟡",
  low: "🔵",
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
}

const TYPE_LABEL: Record<FindingType, string> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  maintainability: "Maintainability",
  test_gap: "Test Gap",
  architecture: "Architecture",
}

const SOURCE_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  merged: "Both models",
}

const REVIEW_EVENT_MAP: Partial<Record<FinalAction, "COMMENT" | "REQUEST_CHANGES" | "APPROVE">> = {
  comment_only: "COMMENT",
  request_changes: "REQUEST_CHANGES",
  needs_human_review: "REQUEST_CHANGES",
  suggest_patch: "COMMENT",
  decline: "COMMENT",
}

export async function reportReview(
  octokit: Octokit,
  decision: FinalDecision,
  prNumber: number
): Promise<void> {
  const { owner, repo } = github.context.repo
  const inlineFindings = decision.findings.filter((f) => f.lineStart && f.lineStart > 0)
  const nonInlineFindings = decision.findings.filter((f) => !f.lineStart || f.lineStart <= 0)

  await dismissPreviousReviews(octokit, prNumber)

  if (inlineFindings.length > 0) {
    await submitPRReview(octokit, decision, prNumber, inlineFindings)
  }

  const summaryBody = formatSummaryComment(decision, nonInlineFindings, inlineFindings.length)
  await upsertComment(octokit, prNumber, summaryBody)

  await postStepSummary(decision)
  setOutputs(decision)

  core.info(`Review posted: ${decision.action}, ${decision.findings.length} findings (${inlineFindings.length} inline, ${nonInlineFindings.length} summary)`)
}

export async function reportIssueTriage(
  octokit: Octokit,
  issueNumber: number,
  classification: string,
  summary: string
): Promise<void> {
  const { owner, repo } = github.context.repo
  const body = [
    COMMENT_MARKER,
    "## PR Sentinel — Issue Triage",
    "",
    `**Classification:** ${classification}`,
    "",
    summary,
    "",
    "---",
    "*Triaged by PR Sentinel*",
  ].join("\n")

  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
}

export async function reportFailure(
  octokit: Octokit,
  prOrIssueNumber: number,
  error: string
): Promise<void> {
  const body = [
    COMMENT_MARKER,
    "## PR Sentinel — Review Failed",
    "",
    `Review could not be completed: ${error}`,
    "",
    "This is non-destructive — no code was modified.",
    "",
    "---",
    "*PR Sentinel*",
  ].join("\n")

  try {
    await upsertComment(octokit, prOrIssueNumber, body)
  } catch {
    core.warning("Failed to post failure comment")
  }
}

// ── PR Review (inline comments with resolve/unresolve) ──

async function submitPRReview(
  octokit: Octokit,
  decision: FinalDecision,
  prNumber: number,
  inlineFindings: ReviewFinding[]
): Promise<void> {
  const { owner, repo } = github.context.repo

  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const commitSha = pr.head.sha
    const event = REVIEW_EVENT_MAP[decision.action] || "COMMENT"

    const comments = inlineFindings.slice(0, 25).map((f) => {
      const comment: {
        path: string
        body: string
        line: number
        side: "RIGHT"
        start_line?: number
        start_side?: "RIGHT"
      } = {
        path: f.file,
        body: formatFindingComment(f),
        line: f.lineEnd && f.lineEnd !== f.lineStart ? f.lineEnd : f.lineStart!,
        side: "RIGHT",
      }

      if (f.lineEnd && f.lineEnd !== f.lineStart && f.lineStart) {
        comment.start_line = f.lineStart
        comment.start_side = "RIGHT"
      }

      return comment
    })

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event,
      body: `PR Sentinel reviewed this PR with ${decision.findings.length} finding(s).`,
      comments,
    })

    core.info(`Submitted PR review: ${event}, ${comments.length} inline comments`)
  } catch (err) {
    core.warning(`PR review submission failed, falling back to individual comments: ${err}`)
    await postIndividualComments(octokit, inlineFindings, prNumber)
  }
}

async function postIndividualComments(
  octokit: Octokit,
  findings: ReviewFinding[],
  prNumber: number
): Promise<void> {
  const { owner, repo } = github.context.repo

  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const commitSha = pr.head.sha

    for (const f of findings.slice(0, 15)) {
      try {
        await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: commitSha,
          path: f.file,
          line: f.lineStart!,
          body: formatFindingComment(f),
        })
      } catch {
        core.debug(`Could not post inline comment on ${f.file}:${f.lineStart}`)
      }
    }
  } catch (err) {
    core.debug(`Inline comments skipped entirely: ${err}`)
  }
}

async function dismissPreviousReviews(octokit: Octokit, prNumber: number): Promise<void> {
  const { owner, repo } = github.context.repo

  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
    })

    for (const review of reviews) {
      if (
        review.body?.includes("PR Sentinel") &&
        review.state === "CHANGES_REQUESTED"
      ) {
        try {
          await octokit.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: prNumber,
            review_id: review.id,
            message: "Superseded by new PR Sentinel review",
          })
        } catch {
          core.debug(`Could not dismiss review ${review.id}`)
        }
      }
    }
  } catch {
    core.debug("Could not list previous reviews for dismissal")
  }
}

// ── Per-Finding Rich Comment (Sentry-style) ──

function formatFindingComment(f: ReviewFinding): string {
  const lines: string[] = []

  const typeLabel = TYPE_LABEL[f.type] || f.type
  lines.push(`**${typeLabel}:** ${f.explanation}`)
  lines.push("")

  const sevEmoji = SEVERITY_EMOJI[f.severity]
  const sevLabel = SEVERITY_LABEL[f.severity]
  const source = SOURCE_LABEL[f.source] || f.source
  const confidence = Math.round(f.confidence * 100)
  lines.push(`**Severity:** ${sevEmoji} ${sevLabel} · **Confidence:** ${confidence}% · **Source:** ${source}`)

  if (f.suggestedFix) {
    lines.push("")
    lines.push("<details>")
    lines.push("<summary>Suggested Fix</summary>")
    lines.push("")
    lines.push("```suggestion")
    lines.push(f.suggestedFix)
    lines.push("```")
    lines.push("")
    lines.push("</details>")
  }

  lines.push("")
  lines.push("<details>")
  lines.push("<summary>Prompt for AI Agent</summary>")
  lines.push("")
  lines.push("```")
  lines.push(buildAgentPrompt(f))
  lines.push("```")
  lines.push("")
  lines.push("</details>")

  lines.push("")
  lines.push("---")
  lines.push("*Did we get this right? 👍 / 👎 to inform future reviews*")

  return lines.join("\n")
}

function buildAgentPrompt(f: ReviewFinding): string {
  const typeLabel = TYPE_LABEL[f.type] || f.type
  const location = f.lineStart
    ? `${f.file}#L${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-L${f.lineEnd}` : ""}`
    : f.file

  const parts: string[] = []
  parts.push("Review the code at the location below. A potential issue has been")
  parts.push("identified by an AI agent.")
  parts.push("Verify if this is a real issue. If it is, propose a fix; if not,")
  parts.push("explain why it's not valid.")
  parts.push("")
  parts.push(`Location: ${location}`)
  parts.push(`Type: ${typeLabel}`)
  parts.push("")
  parts.push(`Potential issue: ${f.explanation}`)

  if (f.suggestedFix) {
    parts.push("")
    parts.push(`Suggested fix: ${f.suggestedFix}`)
  }

  return parts.join("\n")
}

// ── Summary Comment (upserted) ──

function formatSummaryComment(
  decision: FinalDecision,
  nonInlineFindings: ReviewFinding[],
  inlineCount: number
): string {
  const lines: string[] = [COMMENT_MARKER]

  const statusEmoji =
    decision.action === "comment_only" ? "✅" :
    decision.action === "request_changes" ? "⚠️" :
    decision.action === "needs_human_review" ? "🛑" : "ℹ️"

  lines.push(`## PR Sentinel Review ${statusEmoji}`)
  lines.push("")

  if (decision.findings.length === 0) {
    lines.push("No issues found. Code looks clean. ✨")
  } else {
    const severityCounts = countBySeverity(decision.findings)
    const countParts: string[] = []
    if (severityCounts.critical) countParts.push(`🔴 ${severityCounts.critical} critical`)
    if (severityCounts.high) countParts.push(`🔴 ${severityCounts.high} high`)
    if (severityCounts.medium) countParts.push(`🟡 ${severityCounts.medium} medium`)
    if (severityCounts.low) countParts.push(`🔵 ${severityCounts.low} low`)

    lines.push(`**${decision.findings.length} finding(s)** — ${countParts.join(" · ")}`)

    if (inlineCount > 0) {
      lines.push("")
      lines.push(`> ${inlineCount} finding(s) posted as inline review comments on the diff.`)
    }
  }

  if (nonInlineFindings.length > 0) {
    lines.push("")
    lines.push("### Findings without line context")
    lines.push("")

    for (const f of nonInlineFindings) {
      const sevEmoji = SEVERITY_EMOJI[f.severity]
      const typeLabel = TYPE_LABEL[f.type] || f.type
      lines.push(`#### ${sevEmoji} ${f.title}`)
      lines.push("")
      lines.push(`**${typeLabel}** in \`${f.file}\` · **Severity:** ${SEVERITY_LABEL[f.severity]} · **Confidence:** ${Math.round(f.confidence * 100)}%`)
      lines.push("")
      lines.push(f.explanation)

      if (f.suggestedFix) {
        lines.push("")
        lines.push("<details>")
        lines.push("<summary>Suggested Fix</summary>")
        lines.push("")
        lines.push("```suggestion")
        lines.push(f.suggestedFix)
        lines.push("```")
        lines.push("")
        lines.push("</details>")
      }

      lines.push("")
      lines.push("<details>")
      lines.push("<summary>Prompt for AI Agent</summary>")
      lines.push("")
      lines.push("```")
      lines.push(buildAgentPrompt(f))
      lines.push("```")
      lines.push("")
      lines.push("</details>")
      lines.push("")
    }
  }

  if (decision.anthropicReview && decision.openaiReview) {
    lines.push("")
    lines.push("<details>")
    lines.push("<summary>Model Summaries</summary>")
    lines.push("")
    lines.push(`**Anthropic (architecture):** ${decision.anthropicReview.summary}`)
    lines.push("")
    lines.push(`**OpenAI (implementation):** ${decision.openaiReview.summary}`)
    lines.push("")
    lines.push("</details>")
  }

  if (decision.critique) {
    const { agreedFindings, disputedFindings } = decision.critique
    if (agreedFindings.length || disputedFindings.length) {
      lines.push("")
      lines.push("<details>")
      lines.push("<summary>Adversarial Debate</summary>")
      lines.push("")
      if (agreedFindings.length) {
        lines.push("**Agreed:**")
        for (const a of agreedFindings) lines.push(`- ✓ ${a}`)
        lines.push("")
      }
      if (disputedFindings.length) {
        lines.push("**Disputed:**")
        for (const d of disputedFindings) lines.push(`- ✗ ${d.finding}: *${d.reason}*`)
        lines.push("")
      }
      lines.push("</details>")
    }
  }

  lines.push("")
  lines.push("---")
  lines.push("")

  const verdict =
    decision.action === "comment_only" ? "No blockers — ready to merge" :
    decision.action === "request_changes" ? "Changes requested — address findings before merge" :
    decision.action === "needs_human_review" ? "Human review required — sensitive changes detected" :
    decision.action

  lines.push(`**Verdict:** ${verdict}`)

  const totalTokens =
    decision.tokenUsage.anthropic.input + decision.tokenUsage.anthropic.output +
    decision.tokenUsage.openai.input + decision.tokenUsage.openai.output
  const seconds = (decision.durationMs / 1000).toFixed(1)

  lines.push("")
  lines.push(`*PR Sentinel — dual-model review in ${seconds}s · ${totalTokens.toLocaleString()} tokens*`)

  return lines.join("\n")
}

// ── Helpers ──

function countBySeverity(findings: ReviewFinding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

async function upsertComment(octokit: Octokit, issueNumber: number, body: string): Promise<void> {
  const { owner, repo } = github.context.repo

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    })

    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
    }
  } catch (err) {
    core.warning(`Failed to upsert comment: ${err}`)
    try {
      const { owner, repo } = github.context.repo
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
    } catch {
      core.warning("Failed to create comment as fallback")
    }
  }
}

async function postStepSummary(decision: FinalDecision): Promise<void> {
  const lines: string[] = []
  lines.push("### PR Sentinel Review")
  lines.push("")
  lines.push("| Metric | Value |")
  lines.push("|--------|-------|")
  lines.push(`| Findings | ${decision.findings.length} |`)
  lines.push(`| Action | \`${decision.action}\` |`)
  lines.push(`| Duration | ${(decision.durationMs / 1000).toFixed(1)}s |`)
  lines.push(`| Anthropic tokens | ${(decision.tokenUsage.anthropic.input + decision.tokenUsage.anthropic.output).toLocaleString()} |`)
  lines.push(`| OpenAI tokens | ${(decision.tokenUsage.openai.input + decision.tokenUsage.openai.output).toLocaleString()} |`)

  if (decision.findings.length > 0) {
    lines.push("")
    lines.push("| Severity | Count |")
    lines.push("|----------|-------|")
    const counts = countBySeverity(decision.findings)
    for (const [sev, count] of Object.entries(counts)) {
      if (count > 0) lines.push(`| ${SEVERITY_EMOJI[sev as FindingSeverity]} ${SEVERITY_LABEL[sev as FindingSeverity]} | ${count} |`)
    }
  }

  core.summary.addRaw(lines.join("\n"))
  await core.summary.write()
}

function setOutputs(decision: FinalDecision): void {
  const artifact = {
    version: 1,
    timestamp: new Date().toISOString(),
    action: decision.action,
    rationale: decision.rationale,
    findings: decision.findings,
    token_usage: decision.tokenUsage,
    duration_ms: decision.durationMs,
  }

  core.setOutput("review_json", JSON.stringify(artifact))
  core.setOutput("findings_count", decision.findings.length.toString())
  core.setOutput("action", decision.action)
}
