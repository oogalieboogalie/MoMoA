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

import { Sandbox } from 'e2b';
import { DurableStream } from '@durable-streams/client';
import { randomUUID } from 'crypto';
import { 
    AgentEnvironment, 
    AgentConfig, 
    AgentSession 
} from '../agentEnvironmentProvider.js';
import { E2BExecutionProvider } from '../executionProviders/e2BExecutionProvider.js';
import { RUNNER_SCRIPT_FILES, STUB_FILES } from '../acpSandbox.js';
import { FilePayload } from '../executionProvider.js';
import { shellescape } from '../../utils/sandboxUtils.js';

const RUNNER_DIR = "/home/user/runner";
const PROJECT_DIR = "/home/user/project";
const DURABLE_STREAM_PORT = 4437;

export class E2BAgentEnvironment implements AgentEnvironment {
    providerName = "E2B Agent Environment";
    private sandbox: Sandbox | null = null;

    constructor(
        private e2bAPIKey: string,
        private agentConfig: AgentConfig
    ) {} 

    getAgentName(): string {
        return this.agentConfig.agentName;
    }

    async provision(files?: FilePayload[], additionalDependencyInstallCommand?: string): Promise<void> {
        console.log("[E2BOrchestrator] Provisioning new sandbox...");
        

        this.sandbox = await Sandbox.create("code-interpreter-v1", { 
            apiKey: this.e2bAPIKey,
            timeoutMs: 3_600_000 // 1 hour max lifespan
        });

        const projectDir = "/home/user/project";
        await this.sandbox.files.makeDir(projectDir);
        const provider = new E2BExecutionProvider(this.e2bAPIKey, this.sandbox);

        // Inject project Files.
        if (files && files.length > 0) {
            console.log(`[E2BOrchestrator] Injecting ${files.length} Project files...`);
            await provider.stageFiles(files, projectDir);
        }

        // Inject agent-specific files using the ExecutionProvider's helper
        if (this.agentConfig.files && this.agentConfig.files.length > 0) {
            console.log(`[E2BOrchestrator] Injecting ${this.agentConfig.files.length} Agent files...`);
            await provider.stageFiles(this.agentConfig.files, projectDir);
        }

        // Install the internal Node.js Runner Script
        console.log("[E2BOrchestrator] Staging internal session runner...");
        await provider.stageFiles(RUNNER_SCRIPT_FILES, RUNNER_DIR);

        // Run the install
        console.log("[E2BOrchestrator] Running npm install for runner...");
        await this.sandbox.commands.run("npm install", { cwd: RUNNER_DIR, timeoutMs: 120000 });

        if (this.agentConfig.installer) {
            console.log(`[E2BOrchestrator] Running custom installer for ${this.agentConfig.agentName}...`);
            await this.sandbox.commands.run(this.agentConfig.installer, { cwd: RUNNER_DIR, timeoutMs: 120000 });
        }

        if (additionalDependencyInstallCommand) {
            console.log(`[E2BOrchestrator] Installing additional dependencies...`);
            await this.sandbox.commands.run(additionalDependencyInstallCommand, { cwd: RUNNER_DIR, timeoutMs: 120000 });
        }

        // Stage the LMDB stub AFTER install so NPM doesn't overwrite it
        await provider.stageFiles(STUB_FILES, RUNNER_DIR);
    }

    async startSession(_timeout: number): Promise<AgentSession> {
        if (!this.sandbox) throw new Error("Sandbox not provisioned. Call provision() first.");

        const sessionId = randomUUID();
        console.log(`[E2BOrchestrator] Starting session ${sessionId}...`);

        // 1. Build the startup command for the runner script
        const envArgs = Object.entries(this.agentConfig.envs || {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        const authArgs = this.agentConfig.authMethodId ? ["--authMethodId", this.agentConfig.authMethodId] : [];
        
        const runnerCmd = shellescape(
            "node",
            `${RUNNER_DIR}/session-runner.js`,
            "--raw",
            "--cmd",
            `${RUNNER_DIR}/node_modules/.bin/${this.agentConfig.command}`,
            ...authArgs,
            ...envArgs
        );

        const commandHandle = await this.sandbox.commands.run(runnerCmd, {
            background: true,
            cwd: PROJECT_DIR,
            envs: { 
                PORT: String(DURABLE_STREAM_PORT), 
                ...this.agentConfig.envs 
            },
            onStdout: (out) => console.log(`[${this.agentConfig.agentName} OUT] ${out}`),
            onStderr: (err) => console.error(`[${this.agentConfig.agentName} ERR] ${err}`)
        });

        // 3. Establish the Durable Stream connection
        const streamUrl = `https://${this.sandbox.getHost(DURABLE_STREAM_PORT)}/v1/stream/messages`;
        
        const ds = new DurableStream({
            url: streamUrl,
            contentType: "application/json",
        });

        let isPolling = false;
        let onMessageHandler: ((data: any) => void) | null = null;
        let onErrorHandler: ((err: Error) => void) | null = null;

        // 4. Return the clean AgentSession object
        return {
            sessionId,
            connectionUrl: streamUrl,

            sendMessage: async (data: any) => {
                const payload = { ...data, _source: "client" };
                ds.append(new TextEncoder().encode(JSON.stringify(payload) + "\n"));
            },

            onMessage: (handler) => {
                onMessageHandler = handler;
                
                // Only start the stream if we haven't already
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
                await commandHandle.wait();
            },

            kill: async () => {
                await commandHandle.kill();
            }
        };
    }

    async teardown(): Promise<void> {
        console.log("[E2BOrchestrator] Tearing down sandbox...");
        if (this.sandbox) {
            await this.sandbox.kill();
            this.sandbox = null;
        }
    }
}