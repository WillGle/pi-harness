import { assertSupportedPlatform } from "../lib/platform.mjs";

// This manifest entry loads before pi-subagents and Harness extensions.
assertSupportedPlatform();

export default function platformGuard() {}
