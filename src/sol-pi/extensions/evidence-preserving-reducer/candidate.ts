/* SPDX-License-Identifier: MIT */
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { commandIdentity, isDiagnosticCategory, type DiagnosticCategory } from "../command-yield/command-results.ts";
import { YIELD_MARKER } from "../command-yield/config.ts";
import { recordValue } from "./config.ts";

export interface ReducibleToolResult {
	readonly command: string;
	readonly commandSha256: string;
	readonly diagnosticCategory: DiagnosticCategory;
	readonly body: string;
	readonly isError: boolean;
	readonly sourceScope: "complete-command" | "delivered-increment";
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
}

export function detailsFullOutputPath(details: unknown): string | undefined {
	const value = recordValue(details, "fullOutputPath");
	return typeof value === "string" ? value : undefined;
}

async function safeOutputPath(path: string, root: string, name: RegExp): Promise<boolean> {
	if (!name.test(basename(path))) return false;
	try {
		const [candidate, realRoot, status] = await Promise.all([realpath(path), realpath(root), lstat(path)]);
		return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === realRoot;
	} catch { return false; }
}

/** Pi 0.87.1 shares fullOutputPath/truncation metadata across both shells. */
async function exactBody(inline: string, details: unknown): Promise<string | undefined> {
	const inlinePath = inline.match(/\[Showing [^\r\n]*Full output:\s*([^\]\r\n]+)\]/u)?.[1]?.trim();
	const candidate = detailsFullOutputPath(details) ?? inlinePath;
	const truncated = recordValue(recordValue(details, "truncation"), "truncated") === true || inlinePath !== undefined;
	if (candidate && await safeOutputPath(candidate, tmpdir(), /^pi-(?:bash|powershell)-[^/\\]+\.log$/u)) {
		try { return await readFile(candidate, "utf8"); } catch { return undefined; }
	}
	return truncated ? undefined : inline;
}

function replaceBlock(event: ToolResultEvent, index: number, prefix: string) {
	return (receipt: string): ToolResultEvent["content"] => event.content.map((block, current) =>
		current === index && block.type === "text" ? { ...block, text: prefix + receipt } : block);
}

async function waitCandidate(event: ToolResultEvent, runtimeDirectory?: string): Promise<ReducibleToolResult | undefined> {
	if (event.content.length !== 1 || event.content[0]?.type !== "text") return undefined;
	const inline = event.content[0].text;
	// Pi discards details on a thrown tool error, so the bounded header also
	// carries the same non-secret identity and exact byte range.
	const header = inline.match(/^\[exec_wait handle=(exec_[a-f0-9]{12}) status=(running|exited|failed|killed) elapsed=\d+s(?: exit_code=(-?\d+))?(?: error=[^\r\n]*)? command_sha256=([a-f0-9]{64}) category=(\w+) start_byte=(\d+) end_byte=(\d+) new_bytes=(\d+) new_lines=\d+\]\r?\n\[([^\r\n]+)\]\r?\n/u);
	if (!header) return undefined;
	const [, handle, status, code, hash, category, start, end, bytes, progress] = header;
	if (!handle || !hash || !isDiagnosticCategory(category) || !progress || status === "running") return undefined;
	if (progress !== "finished; 0 bytes pending") return undefined;
	if (status === "exited" && code === undefined) return undefined;
	if (Number(end) - Number(start) !== Number(bytes)) return undefined;
	const remainder = inline.slice(header[0].length);
	const artifact = remainder.match(/^\[full_output="(?:[^"\\\r\n]|\\.)*"\]\r?\n/u)?.[0] ?? "";
	const increment = remainder.slice(artifact.length);
	if (Buffer.byteLength(increment, "utf8") !== Number(bytes)) return undefined;
	let body = increment;
	let sourceScope: ReducibleToolResult["sourceScope"] = "delivered-increment";
	if (runtimeDirectory) {
		const root = join(runtimeDirectory, "command-yield");
		const path = join(root, `${handle}.log`);
		if (await safeOutputPath(path, root, /^exec_[a-f0-9]{12}\.log$/u)) {
			let full: Buffer;
			try { full = await readFile(path); } catch { return undefined; }
			if (full.length !== Number(end)) return undefined;
			body = full.toString("utf8");
			if (!Buffer.from(body, "utf8").equals(full)) return undefined;
			sourceScope = "complete-command";
		}
	}
	return { command: `sha256:${hash}`, commandSha256: hash, diagnosticCategory: category, body,
		isError: event.isError || status !== "exited" || code !== "0", sourceScope,
		projectReceipt: replaceBlock(event, 0, header[0] + artifact) };
}

export async function reducibleToolResult(event: ToolResultEvent, runtimeDirectory?: string): Promise<ReducibleToolResult | undefined> {
	if (event.toolName === "exec_wait") return waitCandidate(event, runtimeDirectory);
	const shell = event.toolName === "bash" || event.toolName === "powershell";
	if (!shell && event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const command = shell ? event.input.command : recordValue(recordValue(event.input, "then_run"), "command");
	if (typeof command !== "string" || !command) return undefined;
	const identity = commandIdentity(command);
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		if (block.text.includes(YIELD_MARKER) || block.text.includes("[then_run:running]")) return undefined;
		let prefix = "";
		let inline = block.text;
		if (shell) {
			if (event.content.filter((item) => item.type === "text").length !== 1) return undefined;
		} else {
			const marker = event.isError ? "[then_run:failed]" : "[then_run:succeeded]";
			const position = inline.indexOf(marker);
			if (position < 0) continue;
			const offset = position + marker.length;
			const separator = inline.slice(offset).match(/^(?:\r?\n)+/u)?.[0] ?? "";
			prefix = inline.slice(0, offset) + (separator || "\n");
			inline = inline.slice(offset + separator.length);
		}
		const body = await exactBody(inline, event.details);
		if (body === undefined || body.includes(YIELD_MARKER)) return undefined;
		return { command, ...identity, body, isError: event.isError, sourceScope: "complete-command",
			projectReceipt: replaceBlock(event, index, prefix) };
	}
	return undefined;
}
