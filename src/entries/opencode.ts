/**
 * Combined OpenCode entry for npm publish.
 * The three file-entries (opencode-openai/google/anthropic) are the
 * local-dev path (file:// in opencode.jsonc) and work today.
 * The published npm path `opencode plugin pi-jetbrains-junie-bridge` only
 * resolves a single `exports["./server"]` entry, so this module re-exports
 * the three family plugins as enumerated exports. The legacy v0 loader
 * enumerates named exports as separate plugins.
 */
import { makeJuniePlugin } from "./opencode-plugin.ts";

export const junieOpenai = makeJuniePlugin("openai");
export const junieGoogle = makeJuniePlugin("google");
export const junieAnthropic = makeJuniePlugin("anthropic");

// Keep default for any loader that prefers default export
export default junieOpenai;
