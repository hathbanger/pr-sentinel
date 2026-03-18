import type { ModelClient } from "./models/types";
import type { ReviewContext, TriageResult } from "./types";
export declare function triageIssue(ctx: ReviewContext, anthropic: ModelClient | null, openai: ModelClient | null): Promise<TriageResult>;
