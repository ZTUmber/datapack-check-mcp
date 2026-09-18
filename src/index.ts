#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, SpyglassSession } from "./spyglass-client.js";
import { resolveExistingPath } from "./workspace.js";

const session = new SpyglassSession();
const MCP_TOOL_BUDGET_MS = 45_000;

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  return jsonResult({ ok: false, error: message }, true);
}

async function runCli(argv: string[]): Promise<void> {
  const [command, target] = argv;
  try {
    if (command === "--check-file") {
      if (!target) {
        throw new Error("Usage: datapack-check-mcp --check-file <path>");
      }
      const result = await session.checkFile(resolveExistingPath(target));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (command === "--check-project") {
      const root = target ? resolveExistingPath(target) : process.cwd();
      const result = await session.checkProject(root);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("Usage: datapack-check-mcp [--check-file <path> | --check-project [root]]");
  } finally {
    try {
      await session.dispose();
    } catch (error) {
      log(error instanceof Error ? error.message : error);
    }
  }
}

async function runMcp(): Promise<void> {
  const server = new McpServer({
    name: "datapack-check",
    version: "0.1.0",
  });

  server.registerTool(
    "check_file",
    {
      title: "Check datapack file",
      description:
        "Run Spyglass (Datapack Helper Plus engine) diagnostics on one Minecraft datapack file (.mcfunction, pack JSON, .mcmeta, .snbt, .mcdoc). Returns path/line/severity/message.",
      inputSchema: {
        path: z.string().describe("Absolute or relative path to the datapack file"),
      },
    },
    async ({ path: filePath }) => {
      try {
        const result = await session.checkFile(resolveExistingPath(filePath), {
          budgetMs: MCP_TOOL_BUDGET_MS,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "check_project",
    {
      title: "Check datapack project",
      description:
        "Run Spyglass (Datapack Helper Plus engine) on every .mcfunction, pack JSON, .mcmeta, .snbt, and .mcdoc file under a datapack workspace. Pass the pack root (folder with pack.mcmeta) or a parent folder. First run may take longer than a client timeout; if incomplete is true, call again immediately.",
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe("Datapack or workspace root. Defaults to DATAPACK_WORKSPACE or the current working directory."),
      },
    },
    async ({ root }) => {
      try {
        const result = await session.checkProject(root ? resolveExistingPath(root) : undefined, {
          budgetMs: MCP_TOOL_BUDGET_MS,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server listening on stdio");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--check-file" || argv[0] === "--check-project") {
    await runCli(argv);
    return;
  }

  const shutdown = async () => {
    await session.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  await runMcp();
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
