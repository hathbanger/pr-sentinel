# PR Sentinel

Dual-model AI review bot for GitHub pull requests and issues.

Anthropic reviews architecture, correctness, and risk. OpenAI reviews implementation, bugs, and conventions. They critique each other. You get the merged result.

## Quick Start

1. Add secrets to your repo: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`

2. Create `.github/workflows/pr-sentinel.yml`:

```yaml
name: PR Sentinel

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issues:
    types: [opened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: pr-sentinel-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issues' && github.event.action == 'opened') ||
      (github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/bot'))
    steps:
      - uses: actions/checkout@v4
      - uses: 402goose/pr-sentinel@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

That's it. PRs get reviewed, issues get triaged.

## How the Adversarial Loop Works

```
┌─────────────┐     ┌─────────────┐
│  Anthropic   │     │   OpenAI    │
│ (architect)  │     │  (engineer) │
└──────┬───────┘     └──────┬──────┘
       │  Phase 1: Independent review  │
       ▼                               ▼
  ┌─────────┐                   ┌─────────┐
  │ Review A │                   │ Review B │
  └────┬─────┘                   └────┬─────┘
       │                              │
       │  Phase 2: Anthropic ◄────────┘
       │  critiques OpenAI's findings
       ▼
  ┌──────────┐
  │ Critique  │
  └────┬──────┘
       │  Phase 3: OpenAI responds ────►
       │  to critique
       ▼
  ┌──────────────┐
  │ Revised      │
  │ Findings     │
  └────┬─────────┘
       │  Phase 4: Merge + dedupe
       ▼
  ┌──────────────┐
  │ Final Review │
  └──────────────┘
```

The point is structured disagreement. Each model catches what the other misses. Disputes are surfaced, not hidden.

## Configuration

Create `.github/pr-sentinel.yml` in your repo:

```yaml
mode: review                    # review | review_and_suggest | review_and_patch | manual_only

models:
  anthropic:
    enabled: true
    model: claude-sonnet-4-20250514
  openai:
    enabled: true
    model: gpt-4o

review:
  max_files: 50                 # skip review if PR touches more than this
  max_patch_chars: 200000       # truncate patches beyond this
  comment_style: comprehensive  # concise | comprehensive
  inline_comments: true         # post line-level comments
  severity_threshold: medium    # minimum severity to report

security:
  restricted_paths:             # flag for human review if these are touched
    - ".github/workflows/**"
    - "infra/**"
    - "auth/**"
    - "payments/**"
  block_fork_mutation: true     # never mutate code from fork PRs

validation:
  commands:                     # run these before accepting a fix (Phase 2+)
    - "npm ci"
    - "npm test"
```

All fields are optional. Sensible defaults apply.

## Policy Files

PR Sentinel reads these repo files for additional context:

| File | Purpose |
|------|---------|
| `.github/pr-sentinel.yml` | Bot configuration |
| `.github/review-rules.md` | Custom review instructions |
| `.github/architecture-notes.md` | Architecture context for reviews |
| `CODEOWNERS` | Ownership context |

## Slash Commands

Comment on a PR or issue:

| Command | What it does |
|---------|-------------|
| `/bot review` | Trigger a review (useful for re-review) |
| `/bot fix` | Generate a fix (Phase 2) |
| `/bot triage` | Classify and scope an issue |
| `/bot plan` | Generate an implementation plan |
| `/bot explain` | Explain the changes |
| `/bot security-review` | Security-focused review |
| `/bot tests` | Suggest missing test cases |
| `/bot ignore` | Skip this PR/issue |

## Outputs

The action sets these outputs:

| Output | Description |
|--------|-------------|
| `review_json` | Full review as JSON |
| `findings_count` | Number of findings |
| `action` | Decision taken (comment_only, request_changes, etc.) |

## Failure Handling

- If Anthropic fails → OpenAI-only review with warning
- If OpenAI fails → Anthropic-only review with warning
- If both fail → posts failure note, exits non-destructively
- If schema validation fails → retries once
- Fork PRs never get mutation privileges

## Security

PR Sentinel follows GitHub's security recommendations:

- Default read-only permissions on fork PRs
- No secret exposure to untrusted code
- Restricted paths require human review
- Concurrency control prevents overlapping runs
- All model outputs are schema-validated

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | PR review (dual-model, structured output) | ✅ |
| 0.5 | Issue triage (classify + comment) | Planned |
| 1 | Slash commands, `/bot fix`, `/bot review` | Planned |
| 2 | Patch generation, fix PRs, validation | Planned |
| 3 | Policy engine, restricted paths, monorepo | Planned |

## License

MIT
