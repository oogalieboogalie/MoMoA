/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import chalk from "chalk";
import { Sandbox, CommandStartOpts, waitForPort } from "e2b";
import fs from "fs";
import path from "path";

export type FileTreeNode =
  | {
      name: string;
      type: "file";
      executable?: boolean;
      content: Buffer | string;
    }
  | {
      name: string;
      type: "directory";
      children: FileTreeNode[];
    };

export function loadLocalFileTree(dir: string, ignore?: string[]): FileTreeNode {
  let fileTree: FileTreeNode = {
    name: "agent",
    type: "directory",
    children: [],
  };

  let walkDir = (p: string, parent: Extract<FileTreeNode, { type: "directory" }>) => {
    for (let child of fs.readdirSync(p)) {
      if (ignore?.includes(child)) continue;
      let childPath = path.join(p, child);
      let stats = fs.statSync(childPath);
      if (stats.isDirectory()) {
        let node: FileTreeNode = {
          name: child,
          type: "directory",
          children: [],
        };
        parent.children.push(node);
        walkDir(childPath, node);
      } else {
        parent.children.push({
          name: child,
          type: "file",
          content: fs.readFileSync(childPath, "utf-8"),
        });
      }
    }
  };

  walkDir(dir, fileTree);
  return fileTree;
}

export function asText(content: string | Buffer): string {
  return typeof content === "string" ? content : content.toString("utf-8");
}

export async function runAndStream(sandbox: Sandbox, cmd: string, options?: CommandStartOpts) {
  console.log(
    [
      "\n",
      options?.cwd && chalk.dim(chalk.bold(options.cwd)),
      chalk.dim("$ "),
      chalk.whiteBright(cmd),
    ]
      .filter(Boolean)
      .join("")
  );
  return await sandbox.commands.run(cmd, {
    onStderr: (d) => void process.stderr.write(options?.background ? chalk.dim(d) : d),
    onStdout: (d) => void process.stdout.write(options?.background ? chalk.dim(d) : d),
    ...options,
  });
}

export async function loopedWaitForPort(sandbox: Sandbox, port: number) {
  while (true) {
    try {
      await sandbox.commands.run(waitForPort(port).getCmd());
      break;
    } catch (e) {
      // port not yet open
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function normalizeRepoUrl(input: string): {
  url: string;
  org: string;
  repo: string;
} {
  if (!input) {
    return { url: "", org: "", repo: "" };
  }
  let url = input.replace(/\s+/g, '');
  // Remove .git suffix if present
  if (url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  // Handle SSH URLs
  if (url.startsWith("git@")) {
    const parts = url.split(":");
    if (parts.length === 2) {
      const host = parts[0].slice(4); // remove 'git@'
      const path = parts[1];
      url = `https://${host}/${path}`;
    }
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://github.com/" + url;
  }
  try {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      const org = pathParts[0];
      const repo = pathParts[1];
      return { url: parsedUrl.toString(), org, repo };
    }
  } catch (e) {
    // Invalid URL
  }
  return { url: "", org: "", repo: "" };
}

// from npm/shell-escape
export function shellescape(...a: string[]) {
  return a
    .map((s) => {
      if (!/^[A-Za-z0-9_\/-]+$/.test(s)) {
        s = "'" + s.replace(/'/g, "'\\''") + "'";
        s = s
          .replace(/^(?:'')+/g, "") // unduplicate single-quote at the beginning
          .replace(/\\'''/g, "\\'"); // remove non-escaped single-quote if there are enclosed between 2 escaped
      }
      return s;
    })
    .join(" ");
}