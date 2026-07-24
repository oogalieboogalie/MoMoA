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

// @ts-nocheck
import { DurableStream } from "@durable-streams/client";
import chalk from "chalk";
import { CommandHandle, Sandbox as E2BSandboxType } from "e2b";
import {
  AgentRunnerContext,
  makeMetadataUpdate,
  SessionOutboxData,
  SWARM_CLIENT_METHODS,
  SWARM_RUNNER_METHODS
} from "../momoa_core/types";
import { onGlobalTeardown } from "../utils/acpTeardown";
import { normalizeRepoUrl, runAndStream, shellescape } from "../utils/sandboxUtils";
import { CONFIG_KEY_REPO_URL, SECRET_KEY_GITHUB_TOKEN } from "../config/config";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const RUNNER_DIR = "/home/user/runner";
const PROJECT_DIR = "/home/user/project";
const DURABLE_STREAM_PORT = 4437;

// --- CONSTANTS & HELPERS ---

type AgentDef = {
  label: string;
  installer: (sandbox: Sandbox) => Promise<any>;
  command: string;
  env: Record<string, string>;
  authMethodId?: string;
};

export const RUNNER_PACKAGE_JSON = {
  "name": "session-runner",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@agentclientprotocol/sdk": "latest",
    "@durable-streams/client": "latest",
    "@durable-streams/server": "latest",
    "chalk": "^5.3.0",
    "commander": "^11.0.0",
    "simple-git": "^3.22.0",
    "node-fetch": "^3.3.2" 
  }
};

export const getSessionRunnerSrc = (clientMethods: any, runnerMethods: any) => `
import * as acp from "@agentclientprotocol/sdk";
import { DurableStream } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import chalk from "chalk";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import simpleGit from "simple-git";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SWARM_CLIENT_METHODS = ${JSON.stringify(clientMethods)};
const SWARM_RUNNER_METHODS = ${JSON.stringify(runnerMethods)};
const LARGE_FILE_LIMIT_KB = 100;
const MAX_CONTEXT_FILE_SIZE_BYTES = LARGE_FILE_LIMIT_KB * 1024;

async function getFilesRecursively(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const res = path.join(dir, entry.name);
        return entry.isDirectory() ? getFilesRecursively(res) : res;
    }));
    return Array.prototype.concat(...files);
}

async function sweepProjectFiles(projectDir, originalFilesMap) {
    const generatedFiles = [];
    const allFiles = await getFilesRecursively(projectDir);

    for (const fullPath of allFiles) {
        const relativePath = path.relative(projectDir, fullPath);
        const baseName = path.basename(relativePath);

        // Ignore noise patterns from CloudRunWorker
        if (baseName.startsWith('.') || 
            relativePath.includes('node_modules') || 
            relativePath.includes('__pycache__') || 
            baseName.endsWith('.pyc') || 
            baseName === 'target' || 
            relativePath.startsWith('target/')) continue;

        try {
            const stats = await fs.stat(fullPath);
            if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                const contentBuffer = await fs.readFile(fullPath);
                
                // Consistency check: binary if contains null bytes or exceeds 100KB
                const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                const isTooLargeForText = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);
                const treatAsBinary = isBinary || isTooLargeForText;

                const newContentBase64 = contentBuffer.toString('base64');
                const originalContent = originalFilesMap.get(path.normalize(relativePath));

                if (originalContent === undefined || originalContent !== newContentBase64) {
                    generatedFiles.push({
                        path: relativePath,
                        content: newContentBase64,
                        isBinary: treatAsBinary
                    });
                }
            }
        } catch (e) {
            console.error(\`Error sweeping file \${relativePath}:\`, e);
        }
    }
    return generatedFiles;
}

function makeMetadataUpdate(data) {
  return { ...data, _source: "runner" };
}

function shellescape(...args) {
  return args.map(arg => {
    if (/^[A-Za-z0-9_\\/-]+$/.test(arg)) return arg;
    return "'" + arg.replace(/'/g, "'\\\\''") + "'";
  }).join(' ');
}

class Emitter {
  constructor() { this.events = {}; }
  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
    return this;
  }
  emit(event, ...args) {
    if (!this.events[event]) return false;
    this.events[event].forEach(listener => listener(...args));
    return true;
  }
}

class ACPClient extends Emitter {
  constructor(options = {}) {
    super();
    this.terminals = new Map();
    this.raw = !!options.raw;
    this.extNotification = async () => {};
    this.extMethod = async () => ({});
  }

  async requestPermission(params) {
    if (!this.raw) {
      console.warn(\`\\n[Client] Permission requested (auto-accept): \${params.toolCall.title}\`);
    }
    if (params.options && params.options.length > 0) {
      const selectedOption = params.options.find(o => o.optionId === 'proceed_once') || params.options[0];
      
      if (!this.raw) {
        console.warn(\`\\n[Client] Auto-selecting option: \${selectedOption.name}\`);
      }
      return { outcome: { outcome: "selected", optionId: selectedOption.optionId || "" } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params) {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text" && !this.raw) {
          process.stdout.write(update.content.text);
        }
        break;
      case "tool_call":
        if (!this.raw) console.warn(\`\\n🔧 Tool call: \${update.title} (\${update.status})\`);
        break;
      case "tool_call_update":
        if (!this.raw) console.warn(\`\\n🔧 Tool call update: \${update.status}\`);
        break;
      case "agent_thought_chunk":
        if (!this.raw) process.stdout.write(\`\\r[Thinking...]\`);
        break;
      default:
        if (!this.raw) console.log(chalk.dim(update.sessionUpdate));
        break;
    }
  }

  validatePath(filePath) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const normalizedPath = path.normalize(absolutePath);
    const cwd = process.cwd();
    if (!normalizedPath.startsWith(cwd)) {
      throw new Error(\`Access denied: path \${filePath} is outside of project directory\`);
    }
    return normalizedPath;
  }

  async writeTextFile(params) {
    const filePath = this.validatePath(params.path);
    console.warn(\`\\n[Client] Writing file: \${filePath}\`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.content, "utf8");
    return {};
  }

  async readTextFile(params) {
    const filePath = this.validatePath(params.path);
    console.warn(\`\\n[Client] Reading file: \${filePath}\`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      return { content };
    } catch (error) {
      return { content: "" };
    }
  }

  async createTerminal(params) {
    const terminalId = randomUUID();
    console.warn(\`\\n[Client] Creating terminal \${terminalId}: \${params.command} \${params.args?.join(" ") || ""}\`);

    let cmd = \`bash -c \${shellescape(params.command, ...(params.args || []))}\`;
    const terminalProcess = spawn(cmd, {
      cwd: params.cwd || process.cwd(),
      env: { ...process.env, ...Object.fromEntries((params.env || []).map((e) => [e.name, e.value])) },
      shell: true,
    });

    const termState = { output: "", exitStatus: undefined };
    const exitPromise = new Promise((resolve) => {
      terminalProcess.on("exit", (code, signal) => {
        termState.exitStatus = { exitCode: code !== null ? code : undefined, signal: signal !== null ? signal : undefined };
        resolve(termState.exitStatus);
      });
    });

    terminalProcess.stdout?.on("data", (data) => {
      termState.output += data.toString();
      this.emit("terminalUpdate", { terminalId, stdoutChunk: data.toString() });
      process.stdout.write(chalk.green(data.toString()));
    });

    terminalProcess.stderr?.on("data", (data) => {
      termState.output += data.toString();
      process.stdout.write(chalk.yellow(data.toString()));
      this.emit("terminalUpdate", { terminalId, stderrChunk: data.toString() });
    });

    this.terminals.set(terminalId, { process: terminalProcess, state: termState, exitPromise });
    return { terminalId };
  }

  async terminalOutput(params) {
    const term = this.terminals.get(params.terminalId);
    if (!term) throw new Error(\`Terminal \${params.terminalId} not found\`);
    return { output: term.state.output, exitStatus: term.state.exitStatus, truncated: false };
  }

  async releaseTerminal(params) {
    const term = this.terminals.get(params.terminalId);
    if (term) {
      term.process.kill();
      this.terminals.delete(params.terminalId);
    }
  }

  async waitForTerminalExit(params) {
    const term = this.terminals.get(params.terminalId);
    if (!term) throw new Error(\`Terminal \${params.terminalId} not found\`);
    if (term.state.exitStatus) return term.state.exitStatus;
    return await term.exitPromise;
  }

  async killTerminal(params) {
    const term = this.terminals.get(params.terminalId);
    if (term) term.process.kill();
  }
}

const program = new Command();
const PORT = parseInt(String(process.env.PORT || "4437"), 10);
const DS_STREAM_PATH = "/v1/stream/messages";

program
  .name("session-runner")
  .description("CLI-based ACP client")
  .version("1.0.0")
  .requiredOption("--cmd <cmd>", "The command to run that spawns the ACP agent process")
  .option("--prompt <prompt>", "An initial text prompt to send to the ACP agent")
  .option("--env <env...>", "Environment variables")
  .option("--authMethodId <auth>", "Authentication method")
  .option("--continue <session-id>", "Continue a previous session")
  .option("--raw", "Print raw NDJSON stream to stdout")
  .parse(process.argv);

const options = program.opts();

async function main() {
  // const cmdParts = options.cmd.split(" ");
  // const command = cmdParts[0];
  // const args = cmdParts.slice(1);

  console.log(\`🚀 Spawning ACP agent: \${chalk.green(options.cmd)}\`);

  const spawnedEnv = { ...process.env };
  if (options.env) {
    for (const envVar of options.env) {
      const [key, ...valueRest] = envVar.split("=");
      if (key) spawnedEnv[key] = valueRest.join("=");
    }
  }

  // const agentProcess = spawn(command, args, {
  const agentProcess = spawn(options.cmd, {
    stdio: ["pipe", "pipe", "inherit"],
    shell: true,
    env: spawnedEnv,
  });
  
  agentProcess.on("error", (error) => {
    console.error(\`Failed to start agent process: \${error.message}\`);
    process.exit(1);
  });
  await new Promise((resolve) => agentProcess.once("spawn", resolve));

  let agentInput = Writable.toWeb(agentProcess.stdin);
  let agentOutput = Readable.toWeb(agentProcess.stdout);

  let server = null;
  let streamUrl = process.env.EXTERNAL_STREAM_URL;

  agentProcess.on("exit", (code) => {
    console.log("Agent process exited with code:", code);
    if (server) server.stop(); // Only stop the server if WE started it
    try { agentInput.abort("Process exited"); } catch {}
    try { agentOutput.cancel("Process exited"); } catch {}
  });

  const originalFilesMap = new Map();
  try {
      const initialFiles = await getFilesRecursively(process.cwd());
      for (const fullPath of initialFiles) {
          const relativePath = path.relative(process.cwd(), fullPath);
          if (relativePath.includes('node_modules') || relativePath.includes('__pycache__')) continue;
          
          const stats = await fs.stat(fullPath);
          if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
              const contentBuffer = await fs.readFile(fullPath);
              originalFilesMap.set(path.normalize(relativePath), contentBuffer.toString('base64'));
          }
      }
  } catch (e) {
      console.error("Error building initial file map:", e);
  }

  if (!streamUrl) {
      server = new DurableStreamTestServer({ port: PORT, host: "0.0.0.0" });
      await server.start();
      server.store.create(DS_STREAM_PATH, { contentType: "application/json" });
      streamUrl = server.url + DS_STREAM_PATH;
  }

  let ds = new DurableStream({ url: streamUrl, contentType: "application/json" });
  console.log(\`📡 Durable stream: \${chalk.blue(streamUrl)}\`);

  const transform = new TransformStream({
    transform(chunk, controller) {
      let msgs = new TextDecoder().decode(chunk).split("\\n");
      for (let msg of msgs) {
        if (!msg) continue;
        try {
          const json = { _source: "agent", ...JSON.parse(msg) };
          const ndJson = JSON.stringify(json) + "\\n";
          ds.append(new TextEncoder().encode(ndJson));
          options.raw && process.stdout.write(chalk.cyan(ndJson));
          controller.enqueue(chunk);
        } catch (e) {
          console.error("ERROR Parsing Agent Output: ", msg);
        }
      }
    },
  });
  agentOutput = agentOutput.pipeThrough(transform);

  const writeMirrorTransform = new TransformStream({
    transform(chunk, controller) {
      let msgs = new TextDecoder().decode(chunk).split("\\n");
      for (let msg of msgs) {
        if (!msg) continue;
        try {
            const outbound = JSON.parse(msg);
            const json = { _source: "runner", ...outbound };
            const ndJson = JSON.stringify(json) + "\\n";
            if (outbound._source !== "client") {
              ds.append(new TextEncoder().encode(ndJson), {});
            }
            options.raw && process.stdout.write(chalk.yellow(ndJson));
            controller.enqueue(chunk);
        } catch(e) {}
      }
    },
  });
  writeMirrorTransform.readable.pipeTo(agentInput);
  agentInput = writeMirrorTransform.writable;

  const client = new ACPClient({ raw: options.raw });
  client.on("terminalUpdate", (update) => {
    ds.append(new TextEncoder().encode(JSON.stringify({
          jsonrpc: "2.0",
          method: SWARM_CLIENT_METHODS.terminal_update,
          params: update,
          _source: "runner",
        }) + "\\n")
    );
  });
  const stream = acp.ndJsonStream(agentInput, agentOutput);
  const connection = new acp.ClientSideConnection((_agent) => client, stream);
  let streamPush = (data) => {
    ds.append(new TextEncoder().encode(JSON.stringify(data) + "\\n"));
  };

  try {
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });

    if (options.authMethodId) await connection.authenticate({ methodId: options.authMethodId });

    const canResume = !!initResult.agentCapabilities?.loadSession;
    if (!options.passthrough) {
      console.warn(\`✅ Connected to agent (protocol v\${initResult.protocolVersion})\`);
      console.warn(\`ℹ️  Resumable sessions: \${canResume ? "Yes" : "No"}\`);
    }

    let sessionId;
    if (options.continue) {
      if (!canResume) { console.error("❌ Agent does not support session resumption."); process.exit(1); }
      if (!options.passthrough) console.warn(\`🔄 Resuming session: \${options.continue}\`);
      await connection.loadSession({ sessionId: options.continue, mcpServers: [], cwd: process.cwd() });
      sessionId = options.continue;
    } else {
      const sessionResult = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      sessionId = sessionResult.sessionId;
      if (!options.passthrough) console.warn(\`📝 Created session: \${chalk.cyan(sessionId)}\`);
    }

    streamPush({ jsonrpc: "2.0", method: SWARM_CLIENT_METHODS.agent_ready, params: {} });

    if (options.prompt) await executePrompt(connection, sessionId, options.prompt);

    let res = await ds.stream({ live: true });
    res.subscribeJson(async (batch) => {
      try {
        for (const item of batch.items) {
          const msg = item;

          if (msg._source === "runner") {
            continue;
          }

          if (msg && msg._source === "client") {
            let rawPrint = (dropped = false) => {
              options.raw && process.stdout.write((dropped ? chalk.dim : chalk.green)(JSON.stringify(msg)) + "\\n");
            };

            // FIX: Normalize simplified 'chat' method from tools
            if (msg.method === 'chat' && msg.params?.message) {
               msg.method = SWARM_RUNNER_METHODS.session_prompt;
               msg.params = { prompt: [{ type: "text", text: msg.params.message }] };
            }

            switch (msg.method) {
             case SWARM_RUNNER_METHODS.session_prompt:
                rawPrint();
                try {
                  streamPush(makeMetadataUpdate({ status: "running" }));
                  
                  // 1. Capture the result from connection.prompt
                  const promptResult = await connection.prompt({ ...msg.params, sessionId });
                  streamPush(makeMetadataUpdate({ status: "idle" }));

                  try {
                      const changedFiles = await sweepProjectFiles(process.cwd(), originalFilesMap);
                      if (changedFiles.length > 0) {
                          streamPush({ method: "workspace_files", params: { files: changedFiles } });
                          // Update baseline so we don't resend unmodified files next turn
                          for (const f of changedFiles) {
                              originalFilesMap.set(path.normalize(f.path), f.content);
                          }
                      }
                  } catch(sweepErr) {
                      console.error("Error sweeping workspace files:", sweepErr);
                  }
                  
                  // 2. Stream the result back to the Orchestrator so it triggers the Supervisor
                  streamPush({ _source: "runner", result: promptResult });
                  
                } catch (e) {
                  console.error("Error running prompt", e);
                  streamPush(makeMetadataUpdate({ status: "failed", summary: String(e?.message || e) }));
                }
              case SWARM_RUNNER_METHODS.session_cancel:
                rawPrint();
                await connection.cancel({ ...msg.params, sessionId });
                break;
              default:
                rawPrint(true);
                continue;
            }
          }
        }
      } catch (e) { console.error("Error handling inbox", e); }
    });

    while (true) await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error("Error communicating with agent:", error);
    streamPush(makeMetadataUpdate({ status: "failed", summary: String(error) }));
    throw error;
  } finally {
    agentProcess.kill();
    await server?.stop();
    setTimeout(() => process.exit(0), 100);
  }
}

async function executePrompt(connection, sessionId, text) {
  const promptResult = await connection.prompt({ sessionId, prompt: [{ type: "text", text: text }] });
  console.warn(\`✅ Agent completed with: \${promptResult.stopReason}\`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
`;

export const RUNNER_SCRIPT_FILES: FilePayload[] = [
  {
    path: "package.json",
    content: Buffer.from(JSON.stringify(RUNNER_PACKAGE_JSON, null, 2)).toString('base64'),
    isBinary: false
  },
  {
    path: "session-runner.js",
    content: Buffer.from(getSessionRunnerSrc(SWARM_CLIENT_METHODS, SWARM_RUNNER_METHODS)).toString('base64'),
    isBinary: false
  }
];

export const STUB_FILES: FilePayload[] = [
    {
        path: "node_modules/lmdb/index.js",
        content: Buffer.from("export const open = () => { throw new Error('Stubbed'); }; export default { open };").toString('base64'),
        isBinary: false
    }
];