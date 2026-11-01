import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../sandbox",
);

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List files and folders inside the sandbox workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative directory path inside the sandbox. Defaults to '.'.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a text file from the sandbox workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path inside the sandbox.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write text content to a file in the sandbox workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path inside the sandbox.",
          },
          content: {
            type: "string",
            description: "Full file contents to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];

export function getSandboxRoot(): string {
  return rootDir;
}

function resolveSandboxPath(relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, "") || ".";
  const resolved = path.resolve(rootDir, cleaned);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sandbox: ${relativePath}`);
  }
  return resolved;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "list_dir": {
      const target = resolveSandboxPath(String(args.path ?? "."));
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .map((entry) => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`)
        .join("\n");
    }
    case "read_file": {
      if (typeof args.path !== "string") {
        throw new Error("read_file requires a string path");
      }
      const target = resolveSandboxPath(args.path);
      return await readFile(target, "utf8");
    }
    case "write_file": {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        throw new Error("write_file requires string path and content");
      }
      const target = resolveSandboxPath(args.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, args.content, "utf8");
      return `Wrote ${args.content.length} characters to ${args.path}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
