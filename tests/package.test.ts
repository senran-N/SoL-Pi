/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

interface PackReport {
	files: Array<{ path: string }>;
}

const PACK_ARGUMENTS = ["pack", "--dry-run", "--json"];

/**
 * Node refuses to spawn a `.cmd` file without a shell, so the Windows npm
 * shim has to go through one. The whole command is passed as a single string
 * rather than as arguments, which keeps the shell from re-splitting them and
 * avoids the deprecated args-with-shell form. Every part of it is a literal.
 */
function packedFiles(): string[] {
	const windows = process.platform === "win32";
	const result = windows
		? spawnSync(["npm", ...PACK_ARGUMENTS].join(" "), {
				cwd: process.cwd(),
				encoding: "utf8",
				timeout: 25_000,
				shell: true,
			})
		: spawnSync("npm", PACK_ARGUMENTS, { cwd: process.cwd(), encoding: "utf8", timeout: 25_000 });
	// A spawn that never ran reports no status and no output; without this the
	// failure surfaces as an error with an empty message.
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `npm pack exited with ${result.status}`);
	const report = JSON.parse(result.stdout) as PackReport[];
	return report[0]?.files.map((file) => file.path) ?? [];
}

describe("published package", () => {
	let files: string[];
	beforeAll(() => {
		files = packedFiles();
	}, 30_000);

	it("ships the default cache write/read ratio in the example config", () => {
		const config = JSON.parse(readFileSync("sol-pi.example.json", "utf8")) as Record<string, unknown>;
		expect(config.cacheWriteReadRatio).toBe(12.5);
		expect(config.evidencePreservingReducerProvider).toBe("provider-id");
		expect(config.evidencePreservingReducerModel).toBe("model-id");
	});

	it("contains the standalone entrypoint and no Pi monorepo source", () => {
		expect(files).toContain("src/sol-pi/index.ts");
		expect(files).toContain("sol-pi.example.json");
		expect(files.some((file) => file.startsWith("packages/"))).toBe(false);
		expect(files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
	});

	it("ships Online Context Compact from the standalone source tree", () => {
		expect(files).toContain("src/sol-pi/extensions/online-context-compact/index.ts");
		expect(files).toContain("scripts/check-sol-pi-config.mjs");
		expect(files).toContain("agents-install.md");
		expect(files).not.toContain("AGENTS.md");
		expect(files).not.toContain("CLAUDE.md");
	});
});
