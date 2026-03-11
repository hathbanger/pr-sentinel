# PR Sentinel

Dual-model AI review bot for GitHub PRs and issues. Label-gated. Drop-in.

Anthropic reviews architecture and risk. OpenAI reviews implementation and bugs. They critique each other. You get the merged result.

---

## Install (3 commands)

```bash
# 1. Add secrets (requires gh cli + repo write access)
gh secret set ANTHROPIC_API_KEY --body "sk-ant-..."
gh secret set OPENAI_API_KEY --body "sk-..."

# 2. Create the trigger label
gh label create agent --color 0E8A16 --description "PR Sentinel: AI review and fix"

# 3. Add the workflow
mkdir -p .github/workflows && cat > .github/workflows/pr-sentinel.yml << 'EOF'
name: PR Sentinel

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: pr-sentinel-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: true

jobs:
  sentinel:
    name: PR Sentinel
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: |
      (github.event_name == 'pull_request') ||
      (github.event_name == 'issues') ||
      (github.event_name == 'issue_comment' && (
        contains(github.event.comment.body, '@pr-sentinel') ||
        contains(github.event.comment.body, '/bot')
      ) && (
        github.event.comment.author_association == 'MEMBER' ||
        github.event.comment.author_association == 'OWNER' ||
        github.event.comment.author_association == 'COLLABORATOR'
      )) ||
      (github.event_name == 'pull_request_review_comment' && (
        github.event.comment.author_association == 'MEMBER' ||
        github.event.comment.author_association == 'OWNER' ||
        github.event.comment.author_association == 'COLLABORATOR'
      ))

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: hathbanger/pr-sentinel@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
EOF

# Commit and push
git add .github/workflows/pr-sentinel.yml && git commit -m "ci: add PR Sentinel" && git push
```

Done. Add the `agent` label to any PR or issue to activate.

---

## Install (scripted one-liner)

For agents with `gh` CLI access and repo permissions:

```bash
gh secret set ANTHROPIC_API_KEY --body "$ANTHROPIC_API_KEY" && gh secret set OPENAI_API_KEY --body "$OPENAI_API_KEY" && gh label create agent --color 0E8A16 --description "PR Sentinel" 2>/dev/null; mkdir -p .github/workflows && curl -sL https://raw.githubusercontent.com/hathbanger/pr-sentinel/main/examples/pr-sentinel-review.yml -o .github/workflows/pr-sentinel.yml && git add .github/workflows/pr-sentinel.yml && git commit -m "ci: add PR Sentinel" && git push
```

---

## How It Triggers

Nothing runs unless explicitly activated:

| Trigger | Condition | What Happens |
|---------|-----------|--------------|
| PR opened/pushed | Has `agent` label | Dual-model adversarial review |
| PR labeled | Label is `agent` | Review starts immediately |
| Issue opened | Has `agent` label | Analyze code, propose/apply fix |
| Issue labeled | Label is `agent` | Fix pipeline starts |
| `@pr-sentinel` in any comment | On PR | Re-review |
| `@pr-sentinel` in any comment | On issue | Analyze + propose fix |
| `/bot review` | On PR | Force re-review |
| `/bot fix` | On issue | Force fix attempt |
| Reply to bot comment | On PR review thread | Conversational response |

No `agent` label + no `@mention` + no `/bot` command = nothing runs.

---

## How the Review Works

```
PR labeled "agent" → checkout

   Anthropic (architect)          OpenAI (engineer)
          │                              │
          ▼                              ▼
     Review A                       Review B
          │                              │
          └──────► Anthropic critiques ◄─┘
                   OpenAI's findings
                         │
                         ▼
                    Critique
                         │
              OpenAI responds to ──►
              Anthropic's critique
                         │
                         ▼
                   Merge + dedupe
                         │
                         ▼
            ┌─────────────────────────┐
            │ PR Review Comment       │
            │ + Inline findings       │
            │ + Suggested fixes       │
            │ + AI agent prompts      │
            │ + 👍/👎 feedback        │
            └─────────────────────────┘
```

Four model calls. Structured disagreement. Each finding has severity, confidence, suggested fix, and a copy-pasteable prompt for AI agents.

---

## How the Issue Fix Works

```
Issue labeled "agent"

  1. Extract keywords from issue title + body
  2. Grep codebase for relevant files
  3. Rank files by relevance
  4. Send issue + code context to model
  5. Generate fix plan with confidence score
  6. Cross-model review of proposed fix
  7. Apply changes (if confident enough)

  Mode: propose_only    → comment with fix plan
  Mode: propose_and_pr  → comment + branch + PR (default)
  Mode: yolo            → comment + branch + PR + auto-merge
```

Confidence threshold is configurable (default 0.7). Below threshold → posts analysis but doesn't touch code.

---

## Configuration

Optional. Create `.github/pr-sentinel.yml` for per-repo settings:

```yaml
mode: review

models:
  anthropic:
    enabled: true
    model: claude-sonnet-4-20250514
  openai:
    enabled: true
    model: gpt-4o

trigger:
  require_label: agent        # Label name that activates the bot
  respond_to_mentions: true   # React to @pr-sentinel mentions
  respond_to_replies: true    # Respond to replies on bot comments
  bot_name: pr-sentinel       # Name for @mention detection

review:
  max_files: 50               # Skip review if PR changes more files
  max_patch_chars: 200000     # Truncate large diffs
  comment_style: comprehensive
  inline_comments: true
  severity_threshold: medium

fix:
  mode: propose_and_pr        # propose_only | propose_and_pr | yolo
  confidence_threshold: 0.7   # Only fix if above this (0.0-1.0)
  create_draft_pr: true       # Draft PRs by default

security:
  restricted_paths:           # Force human review for these paths
    - ".github/workflows/**"
    - "infra/**"
    - "auth/**"
    - "payments/**"
  block_fork_mutation: true

validation:
  commands:
    - "npm ci"
    - "npm run lint"
    - "npm test"
```

Without this file, all defaults apply. The bot works out of the box.

---

## Context Files

PR Sentinel reads these from your repo if they exist:

| File | What It Does |
|------|--------------|
| `.github/pr-sentinel.yml` | Configuration (see above) |
| `.github/review-rules.md` | Custom review instructions injected into model prompts |
| `.github/architecture-notes.md` | Architecture context for smarter reviews |

Write these in plain language. They're sent directly to the models as system context.

Example `.github/review-rules.md`:
```markdown
- We use React Server Components by default. Client components need "use client" directive.
- All database queries go through the repository pattern in src/lib/db/.
- Never use console.log in production code. Use the logger from src/lib/logger.ts.
- Error boundaries are required for all page-level components.
```

---

## Slash Commands

Comment on any PR or issue:

| Command | Context | Action |
|---------|---------|--------|
| `/bot review` | PR | Force a review |
| `/bot fix` | Issue | Analyze and propose fix |
| `/bot triage` | Issue | Classify the issue |
| `/bot plan` | Either | Generate implementation plan |
| `/bot explain` | Either | Explain the changes |
| `/bot security-review` | PR | Security-focused review |
| `/bot tests` | PR | Suggest missing tests |
| `/bot ignore` | Either | Skip this item |

---

## Outputs

Use in downstream workflow steps:

```yaml
- uses: hathbanger/pr-sentinel@main
  id: sentinel
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

- run: echo "Findings: ${{ steps.sentinel.outputs.findings_count }}"
```

| Output | Type | Description |
|--------|------|-------------|
| `review_json` | JSON string | Full review with all findings, token usage, timing |
| `findings_count` | number | Total findings |
| `action` | string | `comment_only`, `request_changes`, `needs_human_review`, `decline` |

---

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Anthropic API down | OpenAI-only review with warning |
| OpenAI API down | Anthropic-only review with warning |
| Both APIs down | Posts failure comment, exits cleanly |
| Schema validation fails | Retries once, then posts raw |
| Fix confidence too low | Posts analysis, doesn't touch code |
| Fix apply fails | Cleans up branch, posts error |
| Fork PR | Never mutates code (read-only review) |

Non-destructive by default. If something breaks, the worst case is a comment saying it broke.

---

## Security

- `agent` label required — nothing runs on unlabeled PRs/issues
- Fork PRs get review-only treatment, never code mutation
- Restricted paths (configurable) force human review
- `GITHUB_TOKEN` scoped to minimum required permissions
- All model outputs schema-validated via zod before use
- Concurrency control prevents overlapping runs on same PR/issue
- No secrets exposed to forked PR code

---

## Permissions Required

```yaml
permissions:
  contents: write       # Create fix branches and push commits
  pull-requests: write  # Post reviews, create fix PRs
  issues: write         # Comment on issues
```

For review-only (no fix mode), `contents: read` is sufficient.

---

## Feedback Loop

Every finding includes:

```
Did we get this right? 👍 / 👎 to inform future reviews
```

Reactions on bot comments are readable via GitHub API for training signal.

---

## Agent Integration Notes

**For AI agents installing PR Sentinel into a repo:**

Prerequisites:
- `gh` CLI authenticated with repo access
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` environment variables set
- Push access to the target repo

Verification after install:
```bash
# Confirm workflow exists
gh workflow list | grep -i sentinel

# Confirm secrets are set
gh secret list | grep -E "ANTHROPIC|OPENAI"

# Confirm label exists
gh label list | grep agent

# Test by labeling an existing PR
gh pr edit <number> --add-label agent
```

To customize for a specific repo, write `.github/pr-sentinel.yml` before pushing. The bot reads it on every run.

To install across multiple repos:
```bash
for repo in org/repo1 org/repo2 org/repo3; do
  gh secret set ANTHROPIC_API_KEY --body "$ANTHROPIC_API_KEY" -R "$repo"
  gh secret set OPENAI_API_KEY --body "$OPENAI_API_KEY" -R "$repo"
  gh label create agent --color 0E8A16 -R "$repo" 2>/dev/null
  gh api repos/$repo/contents/.github/workflows/pr-sentinel.yml \
    -X PUT -f message="ci: add PR Sentinel" \
    -f content="$(base64 < .github/workflows/pr-sentinel.yml)"
done
```

---

## License

MIT
