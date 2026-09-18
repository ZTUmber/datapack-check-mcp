import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { Diagnostic, InitializeResult } from "vscode-languageserver-protocol";
import { formatDiagnostics, type CheckResult } from "./format.js";
import {
  findPackRoot,
  languageIdFor,
  listDatapackFiles,
  sameRoot,
  toFileUri,
  toFolderUri,
  uriKey,
} from "./workspace.js";

const require = createRequire(import.meta.url);

export function log(...args: unknown[]): void {
  console.error("[datapack-check-mcp]", ...args);
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const READY_TIMEOUT_MS = envMs("DATAPACK_CHECK_READY_TIMEOUT_MS", 180_000);
const FILE_TIMEOUT_MS = envMs("DATAPACK_CHECK_FILE_TIMEOUT_MS", 8_000);
const PROJECT_TIMEOUT_MS = envMs("DATAPACK_CHECK_PROJECT_TIMEOUT_MS", 600_000);
const DIAG_SETTLE_MS = 400;

function resolveLanguageServer(): string {
  const pkgJson = require.resolve("@spyglassmc/language-server/package.json");
  const bin = path.join(path.dirname(pkgJson), "bin", "server.js");
  if (!fs.existsSync(bin)) {
    throw new Error(`Spyglass language server bin not found: ${bin}`);
  }
  return bin;
}

export class SpyglassSession {
  private workspaceRoot: string | undefined;
  private connection: MessageConnection | undefined;
  private child: ChildProcess | undefined;
  private diagnostics = new Map<string, Diagnostic[]>();
  private openVersions = new Map<string, number>();
  private diagRev = new Map<string, number>();
  private lastDiagAt = 0;
  private analyzedAt: number | undefined;
  private readyPromise: Promise<void> | undefined;
  private diagWaiters = new Set<(uri: string) => void>();
  private starting: Promise<void> | undefined;

  async checkFile(filePath: string): Promise<CheckResult> {
    const abs = path.resolve(filePath);
    const workspace = process.env.DATAPACK_WORKSPACE
      ? path.resolve(process.env.DATAPACK_WORKSPACE)
      : findPackRoot(abs);
    await this.ensure(workspace);
    await this.openAndWait(abs);
    const uri = toFileUri(abs);
    return formatDiagnostics(
      workspace,
      new Map([[uri, this.diagnostics.get(uriKey(uri)) ?? []]]),
    );
  }

  async checkProject(rootPath?: string): Promise<CheckResult> {
    const start = rootPath
      ? path.resolve(rootPath)
      : process.env.DATAPACK_WORKSPACE
        ? path.resolve(process.env.DATAPACK_WORKSPACE)
        : process.cwd();
    const workspace = process.env.DATAPACK_WORKSPACE
      ? path.resolve(process.env.DATAPACK_WORKSPACE)
      : findPackRoot(start);
    await this.ensure(workspace);

    const localFiles = listDatapackFiles(workspace);
    if (localFiles.length === 0) {
      throw new Error(
        `No datapack files found under ${workspace}. Open a folder that contains pack.mcmeta.`,
      );
    }

    const toOpen = localFiles.filter((file) => this.shouldReopen(file));
    log(
      `check_project: ${localFiles.length} files, opening ${toOpen.length}` +
        (toOpen.length === localFiles.length ? " (full scan)" : ""),
    );

    let incomplete = false;
    if (toOpen.length > 0) {
      const keys = toOpen.map((file) => uriKey(toFileUri(file)));
      const batchStart = Date.now();
      for (const file of toOpen) {
        this.sendOpenOrChange(file);
      }
      incomplete = !(await this.waitForCoverage(keys, batchStart, projectWaitMs(toOpen.length)));
    }

    this.analyzedAt = Date.now();

    const localDiagnostics = new Map<string, Diagnostic[]>();
    for (const [uri, items] of this.diagnostics) {
      if (uri.startsWith("file:")) {
        localDiagnostics.set(uri, items);
      }
    }

    return formatDiagnostics(workspace, localDiagnostics, {
      analyzedFiles: localFiles.length,
      totalFiles: localFiles.length,
      openedFiles: toOpen.length,
      incomplete,
    });
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    const child = this.child;
    this.connection = undefined;
    this.child = undefined;
    this.readyPromise = undefined;
    this.workspaceRoot = undefined;
    this.diagnostics.clear();
    this.openVersions.clear();
    this.diagRev.clear();
    this.lastDiagAt = 0;
    this.analyzedAt = undefined;

    if (connection) {
      try {
        await withTimeout(connection.sendRequest("shutdown"), 3000, "shutdown timeout");
        connection.sendNotification("exit");
      } catch {
        // process may already be gone
      }
      connection.dispose();
    }
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async ensure(workspaceRoot: string): Promise<void> {
    if (this.connection && this.workspaceRoot && sameRoot(this.workspaceRoot, workspaceRoot)) {
      await this.readyPromise;
      return;
    }
    if (this.starting) {
      await this.starting;
      if (this.workspaceRoot && sameRoot(this.workspaceRoot, workspaceRoot)) {
        await this.readyPromise;
        return;
      }
    }
    this.starting = this.start(workspaceRoot);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(workspaceRoot: string): Promise<void> {
    await this.dispose();
    if (!fs.existsSync(workspaceRoot)) {
      throw new Error(`Workspace does not exist: ${workspaceRoot}`);
    }

    const serverJs = resolveLanguageServer();
    log(`starting Spyglass for ${workspaceRoot}`);
    const child = spawn(process.execPath, [serverJs, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Failed to open Spyglass stdio pipes");
    }

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) {
        log(text);
      }
    });
    child.on("exit", (code, signal) => {
      log(`Spyglass exited code=${code} signal=${signal ?? ""}`);
    });

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.bindConnection(connection);
    connection.listen();

    this.child = child;
    this.connection = connection;
    this.workspaceRoot = workspaceRoot;

    let resolveReady!: () => void;
    this.readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    connection.onNotification("$/progress", (params: { token: unknown; value?: { kind?: string } }) => {
      if (params.token === "initialize" && params.value?.kind === "end") {
        resolveReady();
      }
    });

    const folderUri = toFolderUri(workspaceRoot);
    const init = (await connection.sendRequest("initialize", {
      processId: process.pid,
      clientInfo: {
        name: "datapack-check-mcp",
        version: "0.1.0",
      },
      locale: process.env.DATAPACK_CHECK_LOCALE ?? "en",
      rootUri: folderUri,
      rootPath: workspaceRoot,
      capabilities: {
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          didChangeConfiguration: {
            dynamicRegistration: true,
          },
        },
        window: {
          workDoneProgress: true,
        },
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
          },
          synchronization: {
            didSave: false,
          },
        },
      },
      initializationOptions: {},
      workspaceFolders: [
        {
          uri: folderUri,
          name: path.basename(workspaceRoot),
        },
      ],
    })) as InitializeResult;

    const caps = (init.capabilities.experimental as { spyglassmc?: { analyzeProject?: boolean } } | undefined)
      ?.spyglassmc;
    if (caps && caps.analyzeProject === false) {
      log("Spyglass did not advertise analyzeProject");
    }

    connection.sendNotification("initialized", {});

    await withTimeout(
      this.readyPromise,
      READY_TIMEOUT_MS,
      `Spyglass did not become ready within ${READY_TIMEOUT_MS}ms (first run downloads the vanilla datapack cache).`,
    );
    log("Spyglass ready");
    this.analyzedAt = Date.now();
  }

  private bindConnection(connection: MessageConnection): void {
    connection.onRequest("client/registerCapability", () => ({}));
    connection.onRequest("client/unregisterCapability", () => ({}));
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/configuration", (params: { items: unknown[] }) =>
      params.items.map(() => ({})),
    );
    connection.onRequest("workspace/workspaceFolders", () => {
      if (!this.workspaceRoot) {
        return null;
      }
      return [
        {
          uri: toFolderUri(this.workspaceRoot),
          name: path.basename(this.workspaceRoot),
        },
      ];
    });

    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const key = uriKey(params.uri);
        this.diagnostics.set(key, params.diagnostics);
        this.diagRev.set(key, (this.diagRev.get(key) ?? 0) + 1);
        this.lastDiagAt = Date.now();
        for (const waiter of this.diagWaiters) {
          waiter(params.uri);
        }
      },
    );
    connection.onNotification("window/logMessage", (params: { message: string }) => {
      log(params.message);
    });
    connection.onNotification("window/showMessage", (params: { message: string }) => {
      log(params.message);
    });
    connection.onNotification("window/showMessageRequest", () => undefined);
  }

  private sendOpenOrChange(filePath: string): string {
    const uri = toFileUri(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    const languageId = languageIdFor(filePath);
    const key = uriKey(uri);
    const nextVersion = (this.openVersions.get(key) ?? 0) + 1;
    this.openVersions.set(key, nextVersion);

    if (nextVersion === 1) {
      this.connection!.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: nextVersion, text },
      });
    } else {
      this.connection!.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text }],
      });
    }
    return key;
  }

  private async openAndWait(filePath: string): Promise<void> {
    const uri = toFileUri(filePath);
    const key = uriKey(uri);
    const revBefore = this.diagRev.get(key) ?? 0;
    this.sendOpenOrChange(filePath);
    await this.waitForRevision(key, uri, revBefore, FILE_TIMEOUT_MS);
  }

  private waitForRevision(
    key: string,
    uri: string,
    revBefore: number,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let debounce: NodeJS.Timeout | undefined;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.diagWaiters.delete(onDiag);
        clearTimeout(timeout);
        if (debounce) {
          clearTimeout(debounce);
        }
        resolve();
      };

      const onDiag = (received: string) => {
        if (uriKey(received) !== key) {
          return;
        }
        if ((this.diagRev.get(key) ?? 0) <= revBefore) {
          return;
        }
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(finish, DIAG_SETTLE_MS);
      };

      const timeout = setTimeout(() => {
        this.diagWaiters.delete(onDiag);
        if (settled) {
          return;
        }
        settled = true;
        if (this.diagnostics.has(key)) {
          resolve();
          return;
        }
        reject(
          new Error(`Timed out waiting for Spyglass diagnostics: ${uri} (${timeoutMs}ms)`),
        );
      }, timeoutMs);

      this.diagWaiters.add(onDiag);
      if ((this.diagRev.get(key) ?? 0) > revBefore) {
        debounce = setTimeout(finish, DIAG_SETTLE_MS);
      }
    });
  }

  private shouldReopen(filePath: string): boolean {
    const key = uriKey(toFileUri(filePath));
    if (!this.diagnostics.has(key)) {
      return true;
    }
    if (this.analyzedAt == null) {
      return false;
    }
    try {
      return fs.statSync(filePath).mtimeMs >= this.analyzedAt - 2000;
    } catch {
      return true;
    }
  }

  private async waitForCoverage(
    keys: string[],
    batchStart: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const quietMs = Math.max(DIAG_SETTLE_MS, 800);
    while (Date.now() < deadline) {
      if (keys.every((key) => this.diagnostics.has(key))) {
        await sleep(DIAG_SETTLE_MS);
        return true;
      }
      if (this.lastDiagAt >= batchStart && Date.now() - this.lastDiagAt >= quietMs) {
        const missing = keys.filter((key) => !this.diagnostics.has(key)).length;
        if (missing > 0) {
          log(`check_project: Spyglass went quiet, ${missing}/${keys.length} files sent no diagnostics`);
        }
        return missing === 0;
      }
      if (this.lastDiagAt < batchStart && Date.now() - batchStart >= 60_000) {
        log("check_project: no new diagnostics 60s after opening files");
        return false;
      }
      await sleep(50);
    }
    const missing = keys.filter((key) => !this.diagnostics.has(key)).length;
    log(`check_project: timed out after ${timeoutMs}ms, still missing ${missing}/${keys.length}`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectWaitMs(openCount: number): number {
  return Math.min(600_000, Math.max(PROJECT_TIMEOUT_MS, openCount * 1500));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
