import * as core from "@actions/core"
import * as github from "@actions/github"
import type { FinalDecision, ReviewFinding, FindingSeverity } from "./types"

type Octokit = ReturnType<typeof github.getOctokit>

const COMMENT_MARKER = "<!-- pr-sentinel-review -->"

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: "🔴",
  high: "🔴",
  medium: "🟡",
  low: "🔵",
}

export async function reportReview(
  octokit: Octokit,
  decision: FinalDecision,
  prNumber: number
): Promise<void> {
  const body = formatReviewComment(decision)
  await upsertComment(octokit, prNumber, body)
  await postStepSummary(decision)

  if (decision.findings.length > 0) {
    await postInlineComments(octokit, decision.findings, prNumber)
  }

  await uploadArtifact(decision)

  core.info(`Review posted: ${decision.action}, ${decision.findings.length} findings`)
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
  const { owner, repo } = github.context.repo
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

function formatReviewComment(decision: FinalDecision): string {
  const lines: string[] = [COMMENT_MARKER]

  const statusEmoji = decision.action === "comment_only" ? "✅" :
    decision.action === "request_changes" ? "⚠️" :
    decision.action === "needs_human_review" ? "🛑" : "ℹ️"

  lines.push(`## PR Sentinel Review ${statusEmoji}`)
  lines.push("")

  if (decision.anthropicReview && decision.openaiReview) {
    lines.push("<details><summary>Model Summaries</summary>")
    lines.push("")
    lines.push(`**Anthropic (architecture):** ${decision.anthropicReview.summary}`)
    lines.push("")
    lines.push(`**OpenAI (implementation):** ${decision.openaiReview.summary}`)
    lines.push("</details>")
    lines.push("")
  }

  if (decision.findings.length === 0) {
    lines.push("No issues found. Code looks clean.")
  } else {
    lines.push(`### Findings (${decision.findings.length})`)
    lines.push("")

    const grouped = groupBySeverity(decision.findings)
    for (const [severity, findings] of grouped) {
      for (const f of findings) {
        const emoji = SEVERITY_EMOJI[f.severity]
        const loc = f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}` : ""
        lines.push(`- ${emoji} **${f.title}** — \`${f.file}${loc}\``)
        lines.push(`  ${f.explanation}`)
        if (f.suggestedFix) {
          lines.push(`  > **Fix:** ${f.suggestedFix}`)
        }
        lines.push("")
      }
    }
  }

  if (decision.critique) {
    const { agreedFindings, disputedFindings } = decision.critique
    if (agreedFindings.length || disputedFindings.length) {
      lines.push("<details><summary>Adversarial Debate</summary>")
      lines.push("")
      if (agreedFindings.length) {
        lines.push("**Agreed:**")
        for (const a of agreedFindings) lines.push(`- ✓ ${a}`)
        lines.push("")
      }
      if (disputedFindings.length) {
        lines.push("**Disputed:**")
        for (const d of disputedFindings) lines.push(`- ✗ ${d.finding}: ${d.reason}`)
        lines.push("")
      }
      lines.push("</details>")
      lines.push("")
    }
  }

  lines.push("---")
  lines.push("")

  const verdict = decision.action === "comment_only" ? "No blockers" :
    decision.action === "request_changes" ? "Changes requested — address findings before merge" :
    decision.action === "needs_human_review" ? "Human review required — sensitive changes detected" :
    decision.action

  lines.push(`**Verdict:** ${verdict}`)

  const totalTokens = decision.tokenUsage.anthropic.input + decision.tokenUsage.anthropic.output +
    decision.tokenUsage.openai.input + decision.tokenUsage.openai.output
  const seconds = (decision.durationMs / 1000).toFixed(1)

  lines.push("")
  lines.push(`*PR Sentinel — dual-model review in ${seconds}s (${totalTokens.toLocaleString()} tokens)*`)

  return lines.join("\n")
}

function groupBySeverity(findings: ReviewFinding[]): Array<[FindingSeverity, ReviewFinding[]]> {
  const groups = new Map<FindingSeverity, ReviewFinding[]>()
  for (const f of findings) {
    const existing = groups.get(f.severity) || []
    existing.push(f)
    groups.set(f.severity, existing)
  }
  const order: FindingSeverity[] = ["critical", "high", "medium", "low"]
  return order.filter((s) => groups.has(s)).map((s) => [s, groups.get(s)!])
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
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
  }
}

async function postInlineComments(
  octokit: Octokit,
  findings: ReviewFinding[],
  prNumber: number
): Promise<void> {
  const { owner, repo } = github.context.repo

  const inlineFindings = findings.filter((f) => f.lineStart && f.lineStart > 0)
  if (inlineFindings.length === 0) return

  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const commitSha = pr.head.sha

    for (const f of inlineFindings.slice(0, 10)) {
      try {
        await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: commitSha,
          path: f.file,
          line: f.lineStart!,
          body: `${SEVERITY_EMOJI[f.severity]} **${f.title}**\n\n${f.explanation}${f.suggestedFix ? `\n\n**Suggested fix:** ${f.suggestedFix}` : ""}`,
        })
      } catch {
        core.debug(`Could not post inline comment on ${f.file}:${f.lineStart}`)
      }
    }
  } catch (err) {
    core.debug(`Inline comments skipped: ${err}`)
  }
}

async function postStepSummary(decision: FinalDecision): Promise<void> {
  const lines: string[] = []
  lines.push("### PR Sentinel Review")
  lines.push("")
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Findings | ${decision.findings.length} |`)
  lines.push(`| Action | ${decision.action} |`)
  lines.push(`| Duration | ${(decision.durationMs / 1000).toFixed(1)}s |`)
  lines.push(`| Anthropic tokens | ${decision.tokenUsage.anthropic.input + decision.tokenUsage.anthropic.output} |`)
  lines.push(`| OpenAI tokens | ${decision.tokenUsage.openai.input + decision.tokenUsage.openai.output} |`)

  core.summary.addRaw(lines.join("\n"))
  await core.summary.write()
}

async function uploadArtifact(decision: FinalDecision): Promise<void> {
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
