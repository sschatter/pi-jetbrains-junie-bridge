export function collectDiagnostics(
  bridge: { baseUrl: string },
  accessToken: string,
  options?: { connectivity?: boolean },
): Promise<any>;
export function formatBalanceToast(balance: any): string;
export function formatDiagnosticsReport(diagnostics: any): string;