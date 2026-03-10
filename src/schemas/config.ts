import { z } from "zod"

export const SentinelConfigSchema = z.object({
  mode: z
    .enum([
      "review",
      "review_and_suggest",
      "review_and_patch",
      "issue_triage",
      "issue_fix",
      "manual_only",
    ])
    .default("review"),

  models: z
    .object({
      anthropic: z
        .object({
          enabled: z.boolean().default(true),
          model: z.string().default("claude-sonnet-4-20250514"),
        })
        .default({}),
      openai: z
        .object({
          enabled: z.boolean().default(true),
          model: z.string().default("gpt-4o"),
        })
        .default({}),
    })
    .default({}),

  review: z
    .object({
      max_files: z.number().default(50),
      max_patch_chars: z.number().default(200_000),
      comment_style: z.enum(["concise", "comprehensive"]).default("comprehensive"),
      inline_comments: z.boolean().default(true),
      severity_threshold: z
        .enum(["low", "medium", "high", "critical"])
        .default("medium"),
    })
    .default({}),

  fix: z
    .object({
      allow_auto_fix: z.boolean().default(false),
      allow_push_to_pr_branch: z.boolean().default(false),
      max_retry_count: z.number().default(2),
      create_draft_pr: z.boolean().default(true),
    })
    .default({}),

  security: z
    .object({
      restricted_paths: z
        .array(z.string())
        .default([
          ".github/workflows/**",
          "infra/**",
          "auth/**",
          "payments/**",
        ]),
      block_fork_mutation: z.boolean().default(true),
    })
    .default({}),

  validation: z
    .object({
      commands: z.array(z.string()).default([]),
    })
    .default({}),
})

export type SentinelConfig = z.infer<typeof SentinelConfigSchema>
