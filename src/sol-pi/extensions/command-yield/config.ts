/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * How long a command may hold the foreground before it yields a handle.
 *
 * Yielding neither kills the command nor loses its output, so the deadline is
 * short on purpose: waiting again is cheap, and a long first bet is not.
 */
export const DEFAULT_COMMAND_YIELD_TIME_MS = 10_000;

export const MIN_YIELD_TIME_MS = 1_000;
export const MAX_YIELD_TIME_MS = 300_000;

/**
 * Prefix every yield trailer carries.
 *
 * It lives here rather than beside the backend so a mechanism that only needs
 * to recognize a yield does not import the shell machinery to do it.
 */
export const YIELD_MARKER = "[sol-pi:command-yield]";
