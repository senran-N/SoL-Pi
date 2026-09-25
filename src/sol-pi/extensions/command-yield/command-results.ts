import { createHash } from "node:crypto";

export type DiagnosticCategory = "test" | "build" | "typecheck" | "lint" | "other";

/** Persist only a fingerprint and a fixed category, never the shell command. */
export function commandIdentity(command: string): { commandSha256: string; diagnosticCategory: DiagnosticCategory } {
	const normalized = command.replace(/(?:\.cmd|\.exe|\.ps1)(?=["'\s]|$)/giu, "").replace(/["']/gu, " ");
	const boundary = /(?:^|[;&|()\s])(?:pytest|ctest|vitest|jest|go\s+test|cargo\s+test|bazel\s+test|dotnet\s+test|python(?:3)?\s+-m\s+(?:pytest|unittest)|(?:npm|pnpm|yarn)(?:\s+run)?\s+test)(?:\s|$)/iu;
	const diagnosticCategory: DiagnosticCategory = boundary.test(normalized) ? "test"
		: /(?:^|[;&|()\s])(?:tsc|(?:npm|pnpm|yarn)\s+(?:run\s+)?typecheck|cargo\s+check|python(?:3)?\s+-m\s+py_compile)(?:\s|$)/iu.test(normalized) ? "typecheck"
		: /(?:^|[;&|()\s])(?:eslint|ruff|(?:npm|pnpm|yarn)\s+(?:run\s+)?lint)(?:\s|$)/iu.test(normalized) ? "lint"
		: /(?:^|[;&|()\s])(?:lake\s+(?:build|env\s+lean)|lean|coq|cargo(?:\s+build)?|zig\s+build|cmake\s+--build|ninja|make|dotnet\s+build|(?:npm|pnpm|yarn)\s+(?:run\s+)?build)(?:\s|$)/iu.test(normalized) ? "build" : "other";
	return { commandSha256: createHash("sha256").update(command, "utf8").digest("hex"), diagnosticCategory };
}

export function isDiagnosticCategory(value: unknown): value is DiagnosticCategory {
	return value === "test" || value === "build" || value === "typecheck" || value === "lint" || value === "other";
}

export const COMMAND_RESULT_SCHEMA = "sol-pi-command-result/1";
