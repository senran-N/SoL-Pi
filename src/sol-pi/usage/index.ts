/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runtimeRoot } from "../runtime-paths.ts";
import { readUsageLedger } from "./ledger.ts";
import { usageReport } from "./report.ts";
import { optimizationReport } from "./optimization.ts";

export function registerUsageReport(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sol_pi_usage",
		label: "SoL-Pi Usage",
		description: "Read local session usage for main, reducer, explorer and summary calls. Separates reported tokens, Pi cost estimates and unknowns; not an invoice or net savings calculation. No model call.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _onUpdate, context) {
			signal?.throwIfAborted();
			const ledger = await readUsageLedger(runtimeRoot(context));
			signal?.throwIfAborted();
			const report = { ...usageReport(context.sessionManager.getEntries(), ledger.records, ledger.invalidRecords),
				optimization: await optimizationReport(runtimeRoot(context)) };
			return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], details: report };
		},
	});
}
