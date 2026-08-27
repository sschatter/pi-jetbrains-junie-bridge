export function collectDiagnostics(
  bridge: { baseUrl: string },
  accessToken: string,
  options?: { connectivity?: boolean },
): Promise<any>;
export function formatBalanceToast(balance: any): string;
export function formatDiagnosticsReport(diagnostics: any): string;
export function availableCredits(balance: any): number | undefined;
export function monthlyAvailableCredits(balance: any): number | undefined;
export function topUpAvailableCredits(balance: any): number | undefined;
export function formatTurnResult(input: {
  durationMs?: number;
  cost?: number;
  remaining?: number;
  topUpRemaining?: number;
}): string;