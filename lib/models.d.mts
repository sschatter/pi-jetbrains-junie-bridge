export const KNOWN_GRAZIE_MODELS: readonly string[];
export const MODEL_CLASSIFICATIONS: {
  readonly SUPPORTED: "supported";
  readonly BLACKLISTED: "blacklisted";
  readonly UNKNOWN: "unknown";
};
export function classifyModel(id: string): {
  id: string;
  status: "supported" | "blacklisted" | "unknown";
  reason?: string;
};
export function classifyBackendModels(ids: string[]): {
  supported: Array<{ id: string; status: "supported" }>;
  blacklisted: Array<{ id: string; status: "blacklisted"; reason?: string }>;
  unknown: Array<{ id: string; status: "unknown" }>;
};
export function buildProviderModels(type: string, port?: number): any[];
export function cleanOldModelsJson(): Promise<void>;