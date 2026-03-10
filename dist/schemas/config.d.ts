import { z } from "zod";
export declare const SentinelConfigSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<["review", "review_and_suggest", "review_and_patch", "issue_triage", "issue_fix", "manual_only"]>>;
    models: z.ZodDefault<z.ZodObject<{
        anthropic: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            model: z.ZodDefault<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            model: string;
        }, {
            enabled?: boolean | undefined;
            model?: string | undefined;
        }>>;
        openai: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            model: z.ZodDefault<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            model: string;
        }, {
            enabled?: boolean | undefined;
            model?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        anthropic: {
            enabled: boolean;
            model: string;
        };
        openai: {
            enabled: boolean;
            model: string;
        };
    }, {
        anthropic?: {
            enabled?: boolean | undefined;
            model?: string | undefined;
        } | undefined;
        openai?: {
            enabled?: boolean | undefined;
            model?: string | undefined;
        } | undefined;
    }>>;
    review: z.ZodDefault<z.ZodObject<{
        max_files: z.ZodDefault<z.ZodNumber>;
        max_patch_chars: z.ZodDefault<z.ZodNumber>;
        comment_style: z.ZodDefault<z.ZodEnum<["concise", "comprehensive"]>>;
        inline_comments: z.ZodDefault<z.ZodBoolean>;
        severity_threshold: z.ZodDefault<z.ZodEnum<["low", "medium", "high", "critical"]>>;
    }, "strip", z.ZodTypeAny, {
        max_files: number;
        max_patch_chars: number;
        comment_style: "concise" | "comprehensive";
        inline_comments: boolean;
        severity_threshold: "low" | "medium" | "high" | "critical";
    }, {
        max_files?: number | undefined;
        max_patch_chars?: number | undefined;
        comment_style?: "concise" | "comprehensive" | undefined;
        inline_comments?: boolean | undefined;
        severity_threshold?: "low" | "medium" | "high" | "critical" | undefined;
    }>>;
    fix: z.ZodDefault<z.ZodObject<{
        allow_auto_fix: z.ZodDefault<z.ZodBoolean>;
        allow_push_to_pr_branch: z.ZodDefault<z.ZodBoolean>;
        max_retry_count: z.ZodDefault<z.ZodNumber>;
        create_draft_pr: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        allow_auto_fix: boolean;
        allow_push_to_pr_branch: boolean;
        max_retry_count: number;
        create_draft_pr: boolean;
    }, {
        allow_auto_fix?: boolean | undefined;
        allow_push_to_pr_branch?: boolean | undefined;
        max_retry_count?: number | undefined;
        create_draft_pr?: boolean | undefined;
    }>>;
    security: z.ZodDefault<z.ZodObject<{
        restricted_paths: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        block_fork_mutation: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        restricted_paths: string[];
        block_fork_mutation: boolean;
    }, {
        restricted_paths?: string[] | undefined;
        block_fork_mutation?: boolean | undefined;
    }>>;
    validation: z.ZodDefault<z.ZodObject<{
        commands: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        commands: string[];
    }, {
        commands?: string[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    mode: "issue_triage" | "issue_fix" | "review" | "review_and_suggest" | "review_and_patch" | "manual_only";
    review: {
        max_files: number;
        max_patch_chars: number;
        comment_style: "concise" | "comprehensive";
        inline_comments: boolean;
        severity_threshold: "low" | "medium" | "high" | "critical";
    };
    validation: {
        commands: string[];
    };
    models: {
        anthropic: {
            enabled: boolean;
            model: string;
        };
        openai: {
            enabled: boolean;
            model: string;
        };
    };
    fix: {
        allow_auto_fix: boolean;
        allow_push_to_pr_branch: boolean;
        max_retry_count: number;
        create_draft_pr: boolean;
    };
    security: {
        restricted_paths: string[];
        block_fork_mutation: boolean;
    };
}, {
    mode?: "issue_triage" | "issue_fix" | "review" | "review_and_suggest" | "review_and_patch" | "manual_only" | undefined;
    review?: {
        max_files?: number | undefined;
        max_patch_chars?: number | undefined;
        comment_style?: "concise" | "comprehensive" | undefined;
        inline_comments?: boolean | undefined;
        severity_threshold?: "low" | "medium" | "high" | "critical" | undefined;
    } | undefined;
    validation?: {
        commands?: string[] | undefined;
    } | undefined;
    models?: {
        anthropic?: {
            enabled?: boolean | undefined;
            model?: string | undefined;
        } | undefined;
        openai?: {
            enabled?: boolean | undefined;
            model?: string | undefined;
        } | undefined;
    } | undefined;
    fix?: {
        allow_auto_fix?: boolean | undefined;
        allow_push_to_pr_branch?: boolean | undefined;
        max_retry_count?: number | undefined;
        create_draft_pr?: boolean | undefined;
    } | undefined;
    security?: {
        restricted_paths?: string[] | undefined;
        block_fork_mutation?: boolean | undefined;
    } | undefined;
}>;
export type SentinelConfig = z.infer<typeof SentinelConfigSchema>;
//# sourceMappingURL=config.d.ts.map