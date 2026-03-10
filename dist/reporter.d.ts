import * as github from "@actions/github";
import type { FinalDecision } from "./types";
type Octokit = ReturnType<typeof github.getOctokit>;
export declare function reportReview(octokit: Octokit, decision: FinalDecision, prNumber: number): Promise<void>;
export declare function reportIssueTriage(octokit: Octokit, issueNumber: number, classification: string, summary: string): Promise<void>;
export declare function reportFailure(octokit: Octokit, prOrIssueNumber: number, error: string): Promise<void>;
export {};
