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

import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DurableStream } from '@durable-streams/client';
import { 
    AgentEnvironment, 
    AgentConfig,  
    AgentSession 
} from '../agentEnvironmentProvider.js';


// Shared constants
import { 
    SWARM_CLIENT_METHODS,
    SWARM_RUNNER_METHODS 
} from '../../momoa_core/types.js';
import { getSessionRunnerSrc, RUNNER_PACKAGE_JSON } from '../acpSandbox.js';
import { shellescape } from '../../utils/sandboxUtils.js';

const RUNNER_DIR = "/home/user/runner";
const PROJECT_DIR = "/home/user/project";
const INTERNAL_PORT = 4437;

export class LocalDockerAgentEnvironment implements AgentEnvironment {
    providerName = "Local Docker Agent Environment";
    
    private containerId: string | null = null;
    private mappedPort: number | null = null;
    private localTempDir: string | null = null;
    private runnerProcess: ChildProcess | null = null;

    constructor(
        private agentConfig: AgentConfig,
        private localDockerImage?: string,
        private dockerMounts?: string[],
        private dockerNetwork?: string
    ) {}

    getAgentName(): string {
        return this.agentConfig.agentName;
    }

    // Helper to run blocking commands inside the container
    private async execInContainer(cmd: string, cwd?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = ["exec"];
            if (cwd) args.push("-w", cwd);
            args.push(this.containerId!, "bash", "-c", cmd);

            const p = spawn("docker", args);
            p.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Docker exec failed with code ${code}: ${cmd}`));
            });
            p.on("error", reject);
        });
    }

    async provision(): Promise<void> {
        console.log("[LocalDockerOrchestrator] Provisioning new container...");
        
        // 👉 Grab the user's image or fallback to the generic node container
        const containerImage = this.localDockerImage || "node:20-slim";
        console.log(`[LocalDockerOrchestrator] Using image: ${containerImage}`);

        const runArgs = ["run", "-d", "--rm"];

        // Add Network Mode
        if (this.dockerNetwork) {
            runArgs.push("--network", this.dockerNetwork);
        }

        // Add Port Mapping (Skip if using host network, as -p is ignored)
        if (this.dockerNetwork !== "host") {
            runArgs.push("-p", `${INTERNAL_PORT}`);
        }

        // Add Volume Mounts
        if (this.dockerMounts && this.dockerMounts.length > 0) {
            for (const mount of this.dockerMounts) {
                runArgs.push("-v", mount);
            }
        }

        // Add the entrypoint and image
        runArgs.push("--entrypoint", "sleep", containerImage, "infinity");

        // 2. Start the persistent container
        const startRes = spawnSync("docker", runArgs, { encoding: "utf-8" });

        if (startRes.error || startRes.status !== 0) {
            throw new Error(`Failed to start docker container: ${startRes.stderr || startRes.error}`);
        }
        
        this.containerId = startRes.stdout.trim();

        // 👉 3. Resolve the port based on the network mode
        if (this.dockerNetwork === "host") {
            // Host network binds directly, so we use the internal port natively
            this.mappedPort = INTERNAL_PORT;
            console.log(`[LocalDockerOrchestrator] Container using host network. Port bound to ${this.mappedPort}`);
        } else {
            // Default bridge network requires checking the mapped port
            const portRes = spawnSync("docker", ["port", this.containerId, `${INTERNAL_PORT}`], { encoding: "utf-8" });
            const match = portRes.stdout.match(/0\.0\.0\.0:(\d+)/);
            if (!match) throw new Error("Could not determine mapped port for local docker sandbox.");
            this.mappedPort = parseInt(match[1], 10);
            console.log(`[LocalDockerOrchestrator] Container ${this.containerId.substring(0, 8)} mapped to host port ${this.mappedPort}`);
        }

        // // 1. Start the persistent container
        // const startRes = spawnSync("docker", [
        //     "run", "-d", "--rm",
        //     "-p", `${INTERNAL_PORT}`, 
        //     "--entrypoint", "sleep",
        //     containerImage, // 👉 Inject the dynamic image variable here
        //     "infinity"
        // ], { encoding: "utf-8" });

        // if (startRes.error || startRes.status !== 0) {
        //     throw new Error(`Failed to start docker container: ${startRes.stderr || startRes.error}`);
        // }
        
        // this.containerId = startRes.stdout.trim();

        // // 2. Discover the mapped host port
        // const portRes = spawnSync("docker", ["port", this.containerId, `${INTERNAL_PORT}`], { encoding: "utf-8" });
        // const match = portRes.stdout.match(/0\.0\.0\.0:(\d+)/);
        // if (!match) throw new Error("Could not determine mapped port for local docker sandbox.");
        // this.mappedPort = parseInt(match[1], 10);

        // console.log(`[LocalDockerOrchestrator] Container ${this.containerId.substring(0, 8)} mapped to host port ${this.mappedPort}`);

        // Setup directories inside the container
        await this.execInContainer(`mkdir -p ${PROJECT_DIR} ${RUNNER_DIR}`);
        
        // Setup a local temporary directory for staging files before copying them over
        this.localTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-docker-"));

        // 3. Stage the Project Files
        if (this.agentConfig.files && this.agentConfig.files.length > 0) {
            console.log(`[LocalDockerOrchestrator] Staging ${this.agentConfig.files.length} project files...`);
            const projectTempDir = path.join(this.localTempDir, "project");
            
            for (const file of this.agentConfig.files) {
                const destPath = path.join(projectTempDir, file.path);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                
                const dataToWrite = file.isBinary 
                    ? Buffer.from(file.content, 'base64')
                    : Buffer.from(file.content, 'base64').toString('utf8');
                await fs.writeFile(destPath, dataToWrite);
            }

            // Bulk copy into the container
            spawnSync("docker", ["cp", `${projectTempDir}/.`, `${this.containerId}:${PROJECT_DIR}/`]);
        }

        // 4. Stage and Install the Runner Script
        console.log("[LocalDockerOrchestrator] Staging internal session runner...");
        const runnerTempDir = path.join(this.localTempDir, "runner");
        await fs.mkdir(runnerTempDir, { recursive: true });
        
        await fs.writeFile(
            path.join(runnerTempDir, "package.json"), 
            JSON.stringify(RUNNER_PACKAGE_JSON, null, 2)
        );
        
        const scriptContent = getSessionRunnerSrc(SWARM_CLIENT_METHODS, SWARM_RUNNER_METHODS);
        await fs.writeFile(path.join(runnerTempDir, "session-runner.js"), scriptContent);

        // Copy runner files to container
        spawnSync("docker", ["cp", `${runnerTempDir}/.`, `${this.containerId}:${RUNNER_DIR}/`]);

        // Install dependencies inside the container
        console.log("[LocalDockerOrchestrator] Installing runner dependencies...");
        await this.execInContainer("npm install", RUNNER_DIR);

        // Stub LMDB
        await this.execInContainer(
            `echo "export const open = () => { throw new Error('Stubbed'); }; export default { open };" > ${RUNNER_DIR}/node_modules/lmdb/index.js`
        );
    }

    async startSession(_timeout: number): Promise<AgentSession> {
        if (!this.containerId || !this.mappedPort) {
            throw new Error("Container not provisioned. Call provision() first.");
        }

        const sessionId = randomUUID();
        console.log(`[LocalDockerOrchestrator] Starting session ${sessionId}...`);

        // 1. Build the runner command
        const envArgs = Object.entries(this.agentConfig.envs || {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        const authArgs = this.agentConfig.authMethodId ? ["--authMethodId", this.agentConfig.authMethodId] : [];
        
        const runnerCmd = shellescape(
            "node",
            `${RUNNER_DIR}/session-runner.js`,
            "--raw",
            "--cmd",
            this.agentConfig.command,
            ...authArgs,
            ...envArgs
        );

        // 2. Spawn the background process inside Docker
        const dockerArgs = [
            "exec", 
            "-w", PROJECT_DIR,
            "-e", `PORT=${INTERNAL_PORT}`,
            this.containerId,
            "bash", "-c", runnerCmd
        ];

        this.runnerProcess = spawn("docker", dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Wait a brief moment to let the Node server spin up inside the container
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 3. Connect the Durable Stream
        const streamUrl = `http://localhost:${this.mappedPort}/v1/stream/messages`;
        
        const ds = new DurableStream({
            url: streamUrl,
            contentType: "application/json",
        });

        let isPolling = false;
        let onMessageHandler: ((data: any) => void) | null = null;
        let onErrorHandler: ((err: Error) => void) | null = null;

        return {
            sessionId,
            connectionUrl: streamUrl,

            sendMessage: async (data: any) => {
                const payload = { ...data, _source: "client" };
                ds.append(new TextEncoder().encode(JSON.stringify(payload) + "\n"));
            },

            onMessage: (handler) => {
                onMessageHandler = handler;
                
                if (!isPolling) {
                    isPolling = true;
                    ds.stream({ live: true }).then(streamRes => {
                        streamRes.subscribeJson((batch: any) => {
                            if (onMessageHandler) {
                                batch.items.forEach((item: any) => onMessageHandler!(item));
                            }
                        });
                    }).catch(err => {
                        if (onErrorHandler) onErrorHandler(err);
                    });
                }
            },

            onError: (handler) => {
                onErrorHandler = handler;
            },

            wait: async () => {
                return new Promise((resolve, reject) => {
                    if (!this.runnerProcess) return resolve();
                    this.runnerProcess.on("close", resolve);
                    this.runnerProcess.on("error", reject);
                });
            },

            kill: async () => {
                console.log(`[LocalDockerOrchestrator] Killing session...`);
                // Force kill the node process inside the container
                await this.execInContainer(`pkill -f session-runner.js`).catch(() => {});
                if (this.runnerProcess) {
                    this.runnerProcess.kill();
                }
            }
        };
    }

    async teardown(): Promise<void> {
        console.log("[LocalDockerOrchestrator] Tearing down container...");
        
        if (this.containerId) {
            spawnSync("docker", ["rm", "-f", this.containerId]);
            this.containerId = null;
        }

        if (this.localTempDir) {
            await fs.rm(this.localTempDir, { recursive: true, force: true }).catch(() => {});
            this.localTempDir = null;
        }
    }
}