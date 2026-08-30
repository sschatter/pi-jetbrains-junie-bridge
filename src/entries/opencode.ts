/**
 * OpenCode entry for npm publish (and local `file://` dir plugin).
 * Re-exports the three family plugins as enumerated exports; the legacy v0
 * loader enumerates named exports as separate plugins.
 */
import { makeJuniePlugin } from "./opencode-plugin.ts";

export const junieOpenai = makeJuniePlugin("openai");
export const junieGoogle = makeJuniePlugin("google");
export const junieAnthropic = makeJuniePlugin("anthropic");

// Keep default for any loader that prefers default export
export default junieOpenai;
