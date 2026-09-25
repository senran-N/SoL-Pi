/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The full record of one exploration, kept out of the model's context.
 *
 * The main window receives a short answer; everything the explorer actually saw
 * is stored by content hash, and the JSONL transcript refers to those immutable
 * bytes. A missing artifact or transcript write explicitly degrades audit status.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TranscriptRecord = Readonly<Record<string, unknown>>;
export type AuditFailure = "transcript-write-failed" | "observation-write-failed" | "sensitive-content-not-archived";
export type AuditStatus = { readonly status: "complete" | "incomplete"; readonly failures: readonly AuditFailure[] };
export type ObservationArtifact = {
	readonly sha256: string;
	readonly bytes: number;
	readonly path: string | null;
	readonly archived: boolean;
};
export type Transcript = ((record: TranscriptRecord) => Promise<void>) & {
	readonly audit: () => AuditStatus;
	readonly archive: (text: string) => Promise<ObservationArtifact>;
};

// This is a conservative last guard, not a promise to identify every secret in
// arbitrary source code. Excluded paths remain the primary storage boundary.
const SENSITIVE = /(?:api[_-]?key|authorization|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?\S+|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

async function regularDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Exploration storage is not a regular directory");
}

async function ensureStorage(storeRoot: string, observations = false): Promise<void> {
	await mkdir(storeRoot, { recursive: true, mode: 0o700 });
	await regularDirectory(storeRoot);
	if (observations) {
		const directory = join(storeRoot, "observations");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await regularDirectory(directory);
	}
}

/** Check both the name and opened inode before any bytes are read or written. */
async function verifyOpened(handle: FileHandle, path: string, storeRoot: string): Promise<void> {
	await regularDirectory(storeRoot);
	await regularDirectory(dirname(path));
	const [named, opened] = await Promise.all([lstat(path), handle.stat()]);
	if (!named.isFile() || named.isSymbolicLink() || !opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
		throw new Error("Exploration storage object is not the opened regular file");
	}
}

function hash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function observationPath(storeRoot: string, sha256: string): string {
	if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid observation hash");
	return join(storeRoot, "observations", `${sha256}.txt`);
}

/** Replay the observed bytes, independent of subsequent edits to project files. */
export async function readArchivedObservation(storeRoot: string, sha256: string): Promise<string> {
	const path = observationPath(storeRoot, sha256);
	await regularDirectory(storeRoot);
	await regularDirectory(dirname(path));
	const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
	try {
		await verifyOpened(handle, path, storeRoot);
		const text = await handle.readFile("utf8");
		if (hash(text) !== sha256) throw new Error("Observation archive integrity check failed");
		return text;
	} finally {
		await handle.close();
	}
}

export function transcriptPath(storeRoot: string, explorationId: string): string {
	if (!/^[a-z0-9_-]{1,100}$/iu.test(explorationId)) throw new Error("Invalid exploration ID");
	return join(storeRoot, `${explorationId}.jsonl`);
}

export function createTranscript(storeRoot: string, explorationId: string): Transcript {
	const path = transcriptPath(storeRoot, explorationId);
	const failures = new Set<AuditFailure>();
	let chain: Promise<void> = Promise.resolve();
	const append = async (record: TranscriptRecord): Promise<void> => {
		const serialized = JSON.stringify({ at: new Date().toISOString(), ...record });
		if (SENSITIVE.test(serialized) || Object.values(record).some((value) => typeof value === "string" && SENSITIVE.test(value))) {
			failures.add("sensitive-content-not-archived");
			return;
		}
		chain = chain
			.then(async () => {
				await ensureStorage(storeRoot);
				const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW, 0o600);
				try {
					await verifyOpened(handle, path, storeRoot);
					await handle.writeFile(`${serialized}\n`, "utf8");
				} finally {
					await handle.close();
				}
			})
			.catch(() => {
				// Do not leak project bytes or provider errors into console logs.
				failures.add("transcript-write-failed");
			});
		await chain;
	};
	return Object.assign(append, {
		audit: (): AuditStatus => ({ status: failures.size > 0 ? "incomplete" : "complete", failures: [...failures] }),
		archive: async (text: string): Promise<ObservationArtifact> => {
			const sha256 = hash(text);
			const bytes = Buffer.byteLength(text, "utf8");
			if (SENSITIVE.test(text)) {
				failures.add("sensitive-content-not-archived");
				return { sha256, bytes, path: null, archived: false };
			}
			try {
				await ensureStorage(storeRoot, true);
				const artifactPath = observationPath(storeRoot, sha256);
				try {
					const handle = await open(artifactPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
					try {
						await verifyOpened(handle, artifactPath, storeRoot);
						await handle.writeFile(text, "utf8");
					} finally {
						await handle.close();
					}
				} catch (error) {
					if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
					// Never overwrite a damaged or colliding object under the same ID.
					await readArchivedObservation(storeRoot, sha256);
				}
				return { sha256, bytes, path: artifactPath, archived: true };
			} catch {
				failures.add("observation-write-failed");
				return { sha256, bytes, path: null, archived: false };
			}
		},
	});
}
