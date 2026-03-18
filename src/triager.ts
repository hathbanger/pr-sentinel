import * as core from "@actions/core"
import type { ModelClient } from "./models/types"
import type { ReviewContext, CodeContext, TriageResult } from "./types"
import { analyzeCodebase, extractKeywords } from "./codebase"

const TRIAGE_SYSTEM = `You are a senior engineer triaging a bug report or feature request for a software project.

Given the issue description, any existing comments, and whatever source code is available, produce a thorough diagnostic analysis.

Your job is NOT to fix the issue — it is to help the team understand it.

Rules:
1. Start with a clear classification of what kind of issue this is
2. Analyze the root cause based on the information available
3. Identify which parts of the codebase are likely involved
4. Suggest concrete investigation steps the team should take
5. Note any missing information that would help diagnose the issue
6. If the issue body already contains good analysis, validate and extend it rather than repeating it
7. Be specific — reference file paths, function names, and patterns from the codebase when possible

Output a JSON object (no markdown fences):
{
  "classification": "bug | security | performance | feature_request | question | infrastructure | documentation",
  "severity": "critical | high | medium | low",
  "title": "concise one-line summary of the issue",
  "root_cause_analysis": "your understanding of the root cause or likely cause",
  "affected_areas": [
    {
      "path": "file or directory path (or 'unknown' if not in codebase)",
      "description": "what role this area plays in the issue",
      "confidence": 0.0-1.0
    }
  ],
  "investigation_steps": [
    "concrete step 1 the team should take",
    "concrete step 2"
  ],
  "questions": [
    "question for the issue reporter if more info is needed"
  ],
  "related_patterns": [
    "any patterns, anti-patterns, or known issues this resembles"
  ],
  "suggested_labels": ["label1", "label2"],
  "estimated_complexity": "trivial | small | medium | large | unknown",
  "confidence": 0.0-1.0
}`

const SECOND_OPINION_SYSTEM = `You are a senior engineer providing a second opinion on a bug report triage.

Given:
- The original issue
- A first engineer's diagnostic analysis
- Available source code

Your job is to:
1. Validate or challenge the first analysis
2. Identify anything they missed
3. Add alternative hypotheses for the root cause
4. Prioritize the investigation steps

Output a JSON object (no markdown fences):
{
  "agrees_with_analysis": true/false,
  "additional_insights": "what the first analysis missed or got wrong",
  "alternative_hypotheses": ["other possible root causes"],
  "priority_adjustments": "any changes to severity or complexity estimates",
  "refined_investigation_steps": ["reordered or additional investigation steps"],
  "confidence": 0.0-1.0
}`

export async function triageIssue(
  ctx: ReviewContext,
  anthropic: ModelClient | null,
  openai: ModelClient | null,
): Promise<TriageResult> {
  if (!ctx.issue) return { success: false, error: "No issue context" }

  const primary = anthropic || openai
  const secondary = anthropic && openai ? openai : null
  if (!primary) return { success: false, error: "No model available" }

  core.info(`Triaging issue #${ctx.issue.number}: ${ctx.issue.title}`)

  const keywords = extractKeywords(ctx.issue.title, ctx.issue.body)
  core.info(`Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}`)

  let codeContext: CodeContext | null = null
  try {
    const result = await analyzeCodebase(keywords)
    if (result.files.length > 0) {
      codeContext = result
      core.info(`Found ${result.files.length} relevant files for context`)
    } else {
      core.info("No relevant files found — proceeding with issue-only triage")
    }
  } catch (err) {
    core.info(`Codebase analysis failed (non-fatal): ${err}`)
  }

  const triage = await generateTriage(primary, ctx, codeContext)

  let secondOpinion: SecondOpinion | null = null
  if (secondary) {
    try {
      secondOpinion = await generateSecondOpinion(secondary, ctx, triage, codeContext)
    } catch (err) {
      core.info(`Second opinion failed (non-fatal): ${err}`)
    }
  }

  return {
    success: true,
    triage,
    secondOpinion: secondOpinion ?? undefined,
    codeContext: codeContext ?? undefined,
  }
}

interface RawTriage {
  classification: string
  severity: string
  title: string
  root_cause_analysis: string
  affected_areas: Array<{ path: string; description: string; confidence: number }>
  investigation_steps: string[]
  questions: string[]
  related_patterns: string[]
  suggested_labels: string[]
  estimated_complexity: string
  confidence: number
}

interface SecondOpinion {
  agreesWithAnalysis: boolean
  additionalInsights: string
  alternativeHypotheses: string[]
  priorityAdjustments: string
  refinedInvestigationSteps: string[]
  confidence: number
}

async function generateTriage(
  model: ModelClient,
  ctx: ReviewContext,
  codeContext: CodeContext | null,
): Promise<TriageResult["triage"]> {
  const issue = ctx.issue!
  const parts: string[] = []

  parts.push(`# Issue #${issue.number}: ${issue.title}`)
  parts.push("")
  parts.push(issue.body)

  if (issue.comments && issue.comments.length > 0) {
    parts.push("")
    parts.push("## Existing Comments")
    for (const comment of issue.comments) {
      parts.push("")
      parts.push(comment)
    }
  }

  if (codeContext) {
    parts.push("")
    parts.push("## Project Structure")
    parts.push(codeContext.structure)
    parts.push("")
    parts.push("## Dependencies")
    parts.push(codeContext.dependencies)

    if (codeContext.files.length > 0) {
      parts.push("")
      parts.push("## Relevant Source Files")
      for (const f of codeContext.files) {
        parts.push("")
        parts.push(`### ${f.path}`)
        parts.push(`Relevance: ${f.relevance}`)
        parts.push("```")
        parts.push(f.content)
        parts.push("```")
      }
    }
  } else {
    parts.push("")
    parts.push("## Note")
    parts.push("No matching source files were found in the repository for the paths/symbols mentioned in this issue.")
    parts.push("Provide your analysis based on the issue description and your engineering expertise.")
  }

  const result = await model.chat(TRIAGE_SYSTEM, parts.join("\n"))
  const parsed = parseTriageResponse(result.text)

  return {
    classification: parsed.classification,
    severity: parsed.severity,
    title: parsed.title,
    rootCauseAnalysis: parsed.root_cause_analysis,
    affectedAreas: parsed.affected_areas,
    investigationSteps: parsed.investigation_steps,
    questions: parsed.questions,
    relatedPatterns: parsed.related_patterns,
    suggestedLabels: parsed.suggested_labels,
    estimatedComplexity: parsed.estimated_complexity,
    confidence: parsed.confidence,
  }
}

async function generateSecondOpinion(
  model: ModelClient,
  ctx: ReviewContext,
  triage: TriageResult["triage"],
  codeContext: CodeContext | null,
): Promise<SecondOpinion> {
  const issue = ctx.issue!
  const parts: string[] = []

  parts.push(`# Issue #${issue.number}: ${issue.title}`)
  parts.push("")
  parts.push(issue.body)
  parts.push("")
  parts.push("## First Engineer's Analysis")
  parts.push(JSON.stringify(triage, null, 2))

  if (codeContext && codeContext.files.length > 0) {
    parts.push("")
    parts.push("## Available Source Code")
    for (const f of codeContext.files.slice(0, 5)) {
      parts.push("")
      parts.push(`### ${f.path}`)
      parts.push("```")
      parts.push(f.content.substring(0, 3000))
      parts.push("```")
    }
  }

  const result = await model.chat(SECOND_OPINION_SYSTEM, parts.join("\n"))
  const parsed = parseSecondOpinion(result.text)

  return {
    agreesWithAnalysis: parsed.agrees_with_analysis,
    additionalInsights: parsed.additional_insights,
    alternativeHypotheses: parsed.alternative_hypotheses,
    priorityAdjustments: parsed.priority_adjustments,
    refinedInvestigationSteps: parsed.refined_investigation_steps,
    confidence: parsed.confidence,
  }
}

function parseTriageResponse(raw: string): RawTriage {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("No JSON object found in triage response")
  const parsed = JSON.parse(match[0])

  return {
    classification: parsed.classification || "bug",
    severity: parsed.severity || "medium",
    title: parsed.title || "Untitled",
    root_cause_analysis: parsed.root_cause_analysis || "",
    affected_areas: parsed.affected_areas || [],
    investigation_steps: parsed.investigation_steps || [],
    questions: parsed.questions || [],
    related_patterns: parsed.related_patterns || [],
    suggested_labels: parsed.suggested_labels || [],
    estimated_complexity: parsed.estimated_complexity || "unknown",
    confidence: parsed.confidence ?? 0.5,
  }
}

function parseSecondOpinion(raw: string): {
  agrees_with_analysis: boolean
  additional_insights: string
  alternative_hypotheses: string[]
  priority_adjustments: string
  refined_investigation_steps: string[]
  confidence: number
} {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("No JSON object found in second opinion response")
  const parsed = JSON.parse(match[0])

  return {
    agrees_with_analysis: parsed.agrees_with_analysis ?? true,
    additional_insights: parsed.additional_insights || "",
    alternative_hypotheses: parsed.alternative_hypotheses || [],
    priority_adjustments: parsed.priority_adjustments || "",
    refined_investigation_steps: parsed.refined_investigation_steps || [],
    confidence: parsed.confidence ?? 0.5,
  }
}
