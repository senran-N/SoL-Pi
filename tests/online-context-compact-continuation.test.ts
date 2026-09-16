/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	collectUserDirectives,
	CONTINUATION_FILES_MAX,
	DIRECTIVE_MAX_LINE_BYTES,
	formatPostCompactionContinuation,
	formatWindowFragment,
	POST_COMPACTION_PLAN_REMINDER,
	recentChangedFiles,
	WINDOW_FRAGMENT_MAX_BYTES,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";

function summary(stepId: string, filesChanged: readonly string[]) {
	return {
		stepId,
		goal: `finish ${stepId}`,
		filesChanged: [...filesChanged],
		verification: [],
		decisions: [],
		nextWork: [],
	};
}

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

describe("post-compaction continuation", () => {
	it("reports the most recently changed files first, without repeats", () => {
		const files = recentChangedFiles([
			summary("one", ["src/a.ts", "src/b.ts"]),
			summary("two", ["src/b.ts", "src/c.ts"]),
		]);

		expect(files).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
	});

	it("bounds the list so the continuation cannot grow with the session", () => {
		const many = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
		expect(recentChangedFiles([summary("one", many)])).toHaveLength(CONTINUATION_FILES_MAX);
	});

	it("drops a path that is empty, oversized, or carries control characters into the prompt", () => {
		const files = recentChangedFiles([
			summary("one", ["   ", "src/a\nb.ts", "src/" + "x".repeat(400) + ".ts", "src/ok.ts"]),
		]);

		expect(files).toEqual(["src/a b.ts", "src/ok.ts"]);
	});

	it("stays the bare reminder when no file was recorded", () => {
		expect(formatPostCompactionContinuation([])).toBe(POST_COMPACTION_PLAN_REMINDER);
	});

	it("names the changed files and tells the model to re-read rather than search", () => {
		const text = formatPostCompactionContinuation(["src/a.ts", "src/b.ts"]);

		expect(text.startsWith(POST_COMPACTION_PLAN_REMINDER)).toBe(true);
		expect(text).toContain("src/a.ts, src/b.ts");
		expect(text).toContain("re-read one before editing it again");
	});
});

describe("user directives", () => {
	it("keeps the original task and the latest instruction", () => {
		const directives = collectUserDirectives([
			userEntry("u1", "add a cache, and do not touch the vendored tree"),
			assistantEntry("a1", "working on it"),
			userEntry("u2", "CORRECTION: keep the public API unchanged"),
		]);

		expect(directives).toEqual({
			task: "add a cache, and do not touch the vendored tree",
			latest: "CORRECTION: keep the public API unchanged",
		});
	});

	it("reports no separate latest instruction when the user spoke once", () => {
		expect(collectUserDirectives([userEntry("u1", "add a cache")])).toEqual({
			task: "add a cache",
			latest: undefined,
		});
	});

	it("ignores anything that is not a user turn, including SoL-Pi's own continuation", () => {
		const entries = [
			assistantEntry("a1", "thinking"),
			{
				type: "custom_message",
				id: "c1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "sol-pi-online-context-compact",
				content: POST_COMPACTION_PLAN_REMINDER,
				display: false,
			} as unknown as SessionEntry,
		];

		expect(collectUserDirectives(entries)).toEqual({ task: undefined, latest: undefined });
	});
});

describe("window fragment directives", () => {
	it("quotes the user instead of relying on the model's paraphrase", () => {
		const fragment = formatWindowFragment({
			windowNumber: 1,
			plan: [{ id: "build", goal: "build it", status: "in_progress" }],
			progress: [summary("scan", ["src/a.ts"])],
			directives: {
				task: "add a cache, and do not touch the vendored tree",
				latest: "keep the public API unchanged",
			},
		});

		expect(fragment).toContain("User instructions (verbatim):");
		expect(fragment).toContain("- task: add a cache, and do not touch the vendored tree");
		expect(fragment).toContain("- latest: keep the public API unchanged");
		// First, because it is the only section nothing else can reconstruct.
		expect(fragment.indexOf("User instructions")).toBeLessThan(fragment.indexOf("Plan:"));
	});

	it("survives a plan large enough to fill the fragment on its own", () => {
		const plan = Array.from({ length: 128 }, (_, index) => ({
			id: `step-${index}`,
			goal: "g".repeat(200),
			status: "pending" as const,
		}));
		const fragment = formatWindowFragment({
			windowNumber: 2,
			plan,
			progress: [summary("scan", ["src/a.ts"])],
			directives: { task: "do not touch the vendored tree", latest: undefined },
		});

		expect(Buffer.byteLength(fragment, "utf8")).toBeLessThanOrEqual(WINDOW_FRAGMENT_MAX_BYTES);
		expect(fragment).toContain("- task: do not touch the vendored tree");
		expect(fragment).toContain("Recorded progress:");
	});

	it("buys the user's words without spending the plan's floor", () => {
		// Everything competes: a long plan, progress and a note index that both fill
		// their reserves, and a pasted wall of text as the instruction. The quoted
		// line has a bound and the plan has a floor, so neither can take the other.
		const plan = Array.from({ length: 40 }, (_, index) => ({
			id: `step-${index}`,
			goal: "g".repeat(60),
			status: "pending" as const,
		}));
		const progress = Array.from({ length: 8 }, (_, index) => ({
			stepId: `s${index}`,
			goal: "goal ".repeat(20),
			filesChanged: ["src/a/very/long/path/file.ts"],
			verification: ["npm run check"],
			decisions: ["d".repeat(100)],
			nextWork: ["n".repeat(80)],
		}));
		const notesIndex = Array.from({ length: 20 }, (_, index) => `note-slug-number-${index} (1234 bytes)`);
		const input = { windowNumber: 5, plan, progress, notesIndex };

		const withDirectives = formatWindowFragment({
			...input,
			directives: { task: "t".repeat(2_000), latest: "l".repeat(2_000) },
		});
		const withoutDirectives = formatWindowFragment(input);
		const steps = (fragment: string): number =>
			fragment.split("\n").filter((line) => line.startsWith("- [pending]")).length;

		expect(Buffer.byteLength(withDirectives, "utf8")).toBeLessThanOrEqual(WINDOW_FRAGMENT_MAX_BYTES);
		expect(withDirectives).toContain("- task: ");
		expect(withDirectives).toContain("Recorded progress:");
		expect(withDirectives).toContain("Notes index:");
		// The section costs the plan some steps, and that cost is capped.
		expect(steps(withDirectives)).toBeGreaterThanOrEqual(10);
		expect(steps(withoutDirectives) - steps(withDirectives)).toBeLessThanOrEqual(8);
	});

	it("bounds one quoted line so a pasted wall of text cannot take the fragment", () => {
		const fragment = formatWindowFragment({
			windowNumber: 3,
			plan: [{ id: "build", goal: "build it", status: "in_progress" }],
			progress: [summary("scan", ["src/a.ts"])],
			directives: { task: "t".repeat(4_000), latest: undefined },
		});

		const task = fragment.split("\n").find((line) => line.startsWith("- task: "));
		expect(Buffer.byteLength(task ?? "", "utf8")).toBeLessThanOrEqual(DIRECTIVE_MAX_LINE_BYTES + "- task: ".length);
		expect(task?.endsWith("...")).toBe(true);
		expect(fragment).toContain("Plan:");
	});

	it("omits the section when the branch recorded no user turn", () => {
		const fragment = formatWindowFragment({
			windowNumber: 4,
			plan: [{ id: "build", goal: "build it", status: "in_progress" }],
			progress: [summary("scan", ["src/a.ts"])],
			directives: { task: undefined, latest: undefined },
		});

		expect(fragment).not.toContain("User instructions");
	});
});
