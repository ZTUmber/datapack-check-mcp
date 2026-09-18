import type { Diagnostic } from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { uriToFsPath } from "./workspace.js";

export type Severity = "error" | "warning" | "info" | "hint";

export interface CheckDiagnostic {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: Severity;
  message: string;
  code?: string | number;
  source?: string;
}

export interface CheckResult {
  ok: boolean;
  workspace: string;
  engine: string;
  errorCount: number;
  warningCount: number;
  diagnostics: CheckDiagnostic[];
  analyzedFiles?: number;
  totalFiles?: number;
  cancelled?: boolean;
  openedFiles?: number;
  incomplete?: boolean;
  message?: string;
}

export function severityName(severity?: DiagnosticSeverity): Severity {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "error";
  }
}

export function formatDiagnostics(
  workspace: string,
  byUri: Map<string, Diagnostic[]>,
  extra?: Pick<
    CheckResult,
    "analyzedFiles" | "totalFiles" | "cancelled" | "openedFiles" | "incomplete" | "message"
  >,
): CheckResult {
  const diagnostics: CheckDiagnostic[] = [];
  for (const [uri, items] of byUri) {
    const filePath = uriToFsPath(uri);
    for (const item of items) {
      diagnostics.push({
        path: filePath,
        line: item.range.start.line + 1,
        column: item.range.start.character + 1,
        endLine: item.range.end.line + 1,
        endColumn: item.range.end.character + 1,
        severity: severityName(item.severity),
        message: typeof item.message === "string" ? item.message : item.message.value,
        code: item.code,
        source: item.source,
      });
    }
  }

  diagnostics.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) {
      return byPath;
    }
    return a.line - b.line || a.column - b.column;
  });

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  return {
    ok: errorCount === 0 && extra?.cancelled !== true && extra?.incomplete !== true,
    workspace,
    engine: "spyglassmc-language-server",
    errorCount,
    warningCount,
    diagnostics,
    ...extra,
  };
}
