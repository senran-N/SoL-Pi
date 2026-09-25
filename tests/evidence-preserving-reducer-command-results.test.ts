import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";
import { commandIdentity } from "../src/sol-pi/extensions/command-yield/command-results.ts";
import { loadReducerConfig, reduceToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { deterministicDiagnostics } from "../src/sol-pi/extensions/evidence-preserving-reducer/diagnostics.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { fakeContext, FakeSessionManager } from "./helpers.ts";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "sol-pi-epr-results-")); paths.push(root); return root; }
function event(toolName: string, text: string, options: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return { type: "tool_result", toolName, toolCallId: "call", input: { command: "npm run build" },
		content: [{ type: "text", text }], isError: false, details: undefined, ...options } as ToolResultEvent;
}
const identity = commandIdentity("npm test --token=private-test-value");
function waited(body: string, status = "exited", pending = 0, code: number | undefined = 0, start = 0): ToolResultEvent {
	const size = Buffer.byteLength(body);
	const progress = status === "running" ? `still running; ${pending} bytes pending, call exec_wait again`
		: pending ? `process finished; ${pending} bytes pending; call exec_wait again to collect the remaining output` : "finished; 0 bytes pending";
	return event("exec_wait", `[exec_wait handle=exec_0123456789ab status=${status} elapsed=1s${code === undefined ? "" : ` exit_code=${code}`} command_sha256=${identity.commandSha256} category=test start_byte=${start} end_byte=${start + size} new_bytes=${size} new_lines=1]\n[${progress}]\n${body}`, { input: { handle: "exec_0123456789ab" }, isError: status === "failed" || code === 1 });
}

describe("EPR command results", () => {
	it.each(["powershell", "bash"])("reads Pi 0.87.1 %s fullOutputPath instead of a truncated preview", async (shell) => {
		const path = join(tmpdir(), `pi-${shell}-${randomUUID()}.log`); paths.push(path);
		const body = "src/main.ts(3,4): error TS2322: Type mismatch.\r\n";
		await writeFile(path, body);
		const candidate = await reducibleToolResult(event(shell, "preview", { details: { fullOutputPath: path } }));
		expect(candidate?.body).toBe(body);
		expect(candidate?.diagnosticCategory).toBe("build");
	});
	it("preserves an image and mutation prefix while projecting only the command output", async () => {
		const candidate = await reducibleToolResult(event("write", "", { input: { then_run: { command: "npm test" } },
			content: [{ type: "text", text: "mutation retained\n[then_run:succeeded]\nraw output" }, { type: "image", data: "img", mimeType: "image/png" }] }));
		expect(candidate?.projectReceipt("receipt")).toEqual([{ type: "text", text: "mutation retained\n[then_run:succeeded]\nreceipt" }, { type: "image", data: "img", mimeType: "image/png" }]);
	});
	it("does not reduce running shells, fused runs, unfinished output or unknown wait formats", async () => {
		const candidates = [event("powershell", "PASS\n[sol-pi:command-yield] still running"),
			event("edit", "[then_run:running]\nPASS", { input: { then_run: { command: "npm test" } } }),
			waited("PASS\n", "running", 0, undefined), waited("PASS\n", "exited", 4),
			(() => { const missingCode = waited("PASS\n"); (missingCode.content[0] as { type: "text"; text: string }).text = (missingCode.content[0] as { text: string }).text.replace(" exit_code=0", ""); return missingCode; })(),
			event("exec_wait", "unknown status")];
		for (const [index, candidate] of candidates.entries()) expect(await reducibleToolResult(candidate), `candidate ${index}`).toBeUndefined();
	});
	it("rebuilds a completed background log from its session spool with exact ranges", async () => {
		const root = await temporary(); await mkdir(join(root, "command-yield"));
		const prefix = "earlier failure\n"; const last = "last diagnostic\n";
		await writeFile(join(root, "command-yield", "exec_0123456789ab.log"), prefix + last);
		const candidate = await reducibleToolResult(waited(last, "exited", 0, 1, Buffer.byteLength(prefix)), root);
		expect(candidate?.body).toBe(prefix + last); expect(candidate?.isError).toBe(true);
		expect(candidate?.sourceScope).toBe("complete-command"); expect(candidate?.commandSha256).toBe(identity.commandSha256);
		expect(candidate?.projectReceipt("receipt")[0]).toMatchObject({ text: expect.stringContaining(`start_byte=${Buffer.byteLength(prefix)}`) });
	});
	it("refuses missing/truncated sources and mismatched range metadata", async () => {
		expect(await reducibleToolResult(event("powershell", "preview", { details: { truncation: { truncated: true } } } as Partial<ToolResultEvent>))).toBeUndefined();
		const changed = waited("hello"); changed.content = [{ type: "text", text: (changed.content[0] as { text: string }).text.replace("new_bytes=5", "new_bytes=4") }];
		expect(await reducibleToolResult(changed)).toBeUndefined();
	});
	it("recognizes Windows script shims and keeps raw command secrets out of identity", () => {
		const identity = commandIdentity('& npm.cmd run build --secret="private-test-value"');
		expect(identity.diagnosticCategory).toBe("build"); expect(JSON.stringify(identity)).not.toContain("private-test-value");
	});
	it("extracts all known compiler diagnostics without a model and archives exact CRLF text", async () => {
		const root = await temporary();
		const body = `${Array.from({ length: 400 }, (_, i) => `[${i + 1}/400] Compiling module${i}\r\n`).join("")}src/main.ts(3,4): error TS2322: Type mismatch.\r\nsrc/other.ts(8,2): warning TS1234: Check this.\r\n`;
		const journal = vi.fn(); const context = fakeContext(new FakeSessionManager());
		const result = await reduceToolResult(journal, loadReducerConfig(root), event("powershell", body, { isError: true,
			input: { command: 'npm.cmd run build --secret="private-test-value"' } }), context);
		expect(result?.details.evidencePreservingReducer).toMatchObject({ reductionMode: "deterministic" });
		const text = (result?.content[0] as { text: string }).text;
		expect(text).toContain("Type mismatch."); expect(text).toContain("Check this."); expect(text).toContain("status=failure");
		expect(JSON.stringify(journal.mock.calls)).not.toContain("private-test-value");
		const source = journal.mock.calls.find(([kind]) => kind === "candidate")?.[1]?.sourcePath;
		expect(await readFile(String(source), "utf8")).toBe(body);
		expect(text).toContain("read tool");
	});
	it("leaves unknown lines and over-budget diagnostics for the verified fallback", async () => {
		const root = await temporary();
		for (const body of ["src/main.ts(3,4): error TS2322: Type mismatch.\nunknown context\n", Array.from({ length: 13 }, (_, i) => `src/${i}.ts(3,4): error TS2322: distinct ${i}.\n`).join("")]) {
			expect(deterministicDiagnostics(body, await archiveBody(root, body), true)).toBeUndefined();
		}
	});
});
