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

import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { DurableStream } from '@durable-streams/client';
import { AgentEnvironment, AgentConfig, AgentSession } from '../agentEnvironmentProvider.js';
import { CloudWorkstationsExecutionProvider } from '../executionProviders/cloudWorkstationsExecutionProvider.js';
import { RUNNER_SCRIPT_FILES, STUB_FILES } from '../acpSandbox.js';
import { FilePayload } from '../executionProvider.js';
import path from 'path';
import { shellescape } from '../../utils/sandboxUtils.js';

const DURABLE_STREAM_PORT = 4437;

export class CloudWorkstationAgentEnvironment implements AgentEnvironment {
    providerName = "Google Cloud Workstations Agent Environment";
    
    private provider: CloudWorkstationsExecutionProvider;
    private env: any;
    private runnerProcess: ChildProcess | null = null;
    private tunnelProcess: ChildProcess | null = null;

    // Dynamic paths to ensure no files are left in /home/user
    private runnerDir: string;
    private projectDir: string;

    constructor(
        googleAccessToken: string,
        private gcpProjectId: string,
        private workstationName: string,
        private agentConfig: AgentConfig
    ) {
        this.env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };
        
        this.runnerDir = `runner`;
        this.projectDir = `project`;

        this.provider = new CloudWorkstationsExecutionProvider(
            googleAccessToken, 
            gcpProjectId, 
            workstationName,
            true
        );
    }

    getAgentName(): string { return this.agentConfig.agentName; }

    private log(message: string) {
        console.log(`[CloudWorkstationOrchestrator] ${new Date().toISOString()} - ${message}`);
    }

    async provision(files?: FilePayload[], additionalDependencyInstallCommand?: string): Promise<void> {
        this.log(`Provisioning temporary workspace in Cloud Workstation.`);

        try {
            // 1. Stage Project and Agent files into the project directory using the provider
            const allProjectFiles = [
                ...(this.agentConfig.files || []),
                ...(files || [])
            ];
            if (allProjectFiles.length > 0) {
                await this.provider.stageFiles(allProjectFiles, this.projectDir);
            }

            // 2. Stage Runner scripts into the runner directory
            await this.provider.stageFiles(RUNNER_SCRIPT_FILES, this.runnerDir);
        } catch (err) {
            this.log(`Provisioning encountered an error. Cleaning up...`);
            await this.teardown(); // Ensure /tmp is cleaned even on partial failure
            throw err;
        }

        this.log(`Environment setup...`);
        // 3. Run Environment Setup (NPM install, installers)
        let setupScript =
`cd ${this.runnerDir} && npm install`;

        if (this.agentConfig.installer)
            setupScript += `&& ${this.agentConfig.installer}`;

        if (additionalDependencyInstallCommand)
            setupScript += `&& ${additionalDependencyInstallCommand}`; 

        // Base64 encode the script to avoid SSH quoting/escaping nightmares
        const scriptContent = Buffer.from(`${setupScript}`).toString('base64');
        
        // Write the script remotely and execute it wrapped in GNU time
        const fullRemoteCommand = `cd ${this.provider.tempWorkspaceFolder} && ` +
            `echo "${scriptContent}" | base64 -d > .task.sh && ` +
            `bash .task.sh`;

        this.log(`Executing environment setup.`);
        const envSetupArgs = [
            'workstations', 'ssh', this.workstationName,
            `--project=${this.gcpProjectId}`,
            `--region=${this.provider.region}`,
            `--cluster=${this.provider.cluster}`,
            `--config=${this.provider.config}`,
            `--command=${fullRemoteCommand}`
        ];

        // const environmentSetupProcess = spawn('gcloud', envSetupArgs, { env: this.env });
        // environmentSetupProcess.stdout?.on('data', (d) => console.log(`[${this.agentConfig.agentName} OUT] ${d.toString().trim()}`));
        // environmentSetupProcess.stderr?.on('data', (d) => console.error(`[${this.agentConfig.agentName} ERR] ${d.toString().trim()}`));

        // environmentSetupProcess.
        await new Promise<void>((resolve, reject) => {
            const environmentSetupProcess = spawn('gcloud', envSetupArgs, { env: this.env });

            environmentSetupProcess.stdout?.on('data', (d) => 
                console.log(`[${this.agentConfig.agentName} OUT] ${d.toString().trim()}`)
            );

            environmentSetupProcess.stderr?.on('data', (d) => 
                console.error(`[${this.agentConfig.agentName} ERR] ${d.toString().trim()}`)
            );

            // This event fires when the process terminates and stdio streams are closed
            environmentSetupProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Process exited with code ${code}`));
                }
            });

            // Handle cases where the command couldn't be spawned at all
            environmentSetupProcess.on('error', (err) => {
                reject(err);
            });
        });

        // 4. Stage stubs AFTER install to ensure they aren't overwritten by npm
        await this.provider.stageFiles(STUB_FILES, this.runnerDir);
    }

    async startSession(_timeout: number): Promise<AgentSession> {
        if (!this.provider.region) {
            await this.provider.resolveWorkstationDetails(this.env);
        }

        const sessionId = randomUUID();
        this.log(`Starting session ${sessionId}...`);

        const projectFolder = path.join(this.provider.tempWorkspaceFolder, this.projectDir);

        const userEnvs = this.agentConfig.envs || {};
        const envPrefix = Object.entries({ PORT: String(DURABLE_STREAM_PORT), ...userEnvs })
            .map(([k, v]) => `${k}='${v}'`)
            .join(' ');

        const envArgs = Object.entries(userEnvs).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        const authArgs = this.agentConfig.authMethodId ? ["--authMethodId", this.agentConfig.authMethodId] : [];
        
        const runnerPath = path.join(this.provider.tempWorkspaceFolder, this.runnerDir, 'session-runner.js');
        const agentCommandPath = path.join(this.provider.tempWorkspaceFolder, this.runnerDir, "/node_modules/.bin/", this.agentConfig.command);

        const rawNodeCmd = shellescape(
            "node", 
            `${runnerPath}`,
            "--raw", 
            "--cmd",
            `${agentCommandPath}`,
            ...authArgs, ...envArgs
        );

        // Execute via a small wrapper script to handle the directory change and env vars
        const sshCommand = `mkdir -p ${projectFolder} && cd ${projectFolder} && ${envPrefix} ${rawNodeCmd}`;

        const sshArgs = [
            'workstations', 'ssh', this.workstationName,
            `--project=${this.gcpProjectId}`,
            `--region=${this.provider.region}`,
            `--cluster=${this.provider.cluster}`,
            `--config=${this.provider.config}`,
            `--command`, sshCommand
        ];

        this.runnerProcess = spawn('gcloud', sshArgs, { env: this.env });
        this.runnerProcess.stdout?.on('data', (d) => console.log(`[${this.agentConfig.agentName} OUT] ${d.toString().trim()}`));
        this.runnerProcess.stderr?.on('data', (d) => console.error(`[${this.agentConfig.agentName} ERR] ${d.toString().trim()}`));

        this.log(`Starting TCP tunnel on port ${DURABLE_STREAM_PORT}...`);
        this.tunnelProcess = spawn('gcloud', [
            'workstations', 'start-tcp-tunnel', this.workstationName, String(DURABLE_STREAM_PORT),
            `--local-host-port=localhost:${DURABLE_STREAM_PORT}`,
            `--project=${this.gcpProjectId}`,
            `--region=${this.provider.region}`,
            `--cluster=${this.provider.cluster}`,
            `--config=${this.provider.config}`
        ], { env: this.env });

        await new Promise(resolve => setTimeout(resolve, 5000));

        const streamUrl = `http://localhost:${DURABLE_STREAM_PORT}/v1/stream/messages`;
        const ds = new DurableStream({ url: streamUrl, contentType: "application/json" });

        let isPolling = false;
        let onMessageHandler: ((data: any) => void) | null = null;
        let onErrorHandler: ((err: Error) => void) | null = null;

        return {
            sessionId,
            connectionUrl: streamUrl,
            sendMessage: async (data: any) => ds.append(new TextEncoder().encode(JSON.stringify({ ...data, _source: "client" }) + "\n")),
            onMessage: (handler) => {
                onMessageHandler = handler;
                if (!isPolling) {
                    isPolling = true;
                    ds.stream({ live: true }).then(streamRes => streamRes.subscribeJson((batch: any) => {
                        if (onMessageHandler) batch.items.forEach((item: any) => onMessageHandler!(item));
                    })).catch(err => { if (onErrorHandler) onErrorHandler(err); });
                }
            },
            onError: (handler) => { onErrorHandler = handler; },
            wait: async () => new Promise((resolve) => {
                if (!this.runnerProcess) return resolve();
                this.runnerProcess.on('close', resolve);
            }),
            kill: async () => await this.teardown()
        };
    }

    async teardown(): Promise<void> {
        this.log("Tearing down Cloud Workstation orchestrator resources...");
        
        // 1. Send remote kill signal to gracefully stop the runner process
        if (this.provider.region) {
            this.log("Sending remote kill signal to the session runner...");
            
            // Only kill the Node process. The provider will handle directory cleanup.
            const killCommand = `pkill -f session-runner.js || true`;
            
            const sshArgs = [
                'workstations', 'ssh', this.workstationName,
                `--project=${this.gcpProjectId}`,
                `--region=${this.provider.region}`,
                `--cluster=${this.provider.cluster}`,
                `--config=${this.provider.config}`,
                `--command`, killCommand
            ];

            try {
                await new Promise<void>((resolve, reject) => {
                    const killProcess = spawn('gcloud', sshArgs, { env: this.env });
                    
                    killProcess.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Remote kill command exited with code ${code}`));
                        }
                    });

                    killProcess.on('error', (err) => reject(err));
                });
                this.log("Remote session runner terminated.");
            } catch (error: any) {
                this.log(`Remote kill command failed: ${error.message}`);
            }
        }

        // 2. Kill local wrapper and tunnel processes
        if (this.runnerProcess) { 
            this.runnerProcess.kill('SIGTERM'); 
            this.runnerProcess = null; 
        }
        if (this.tunnelProcess) { 
            this.tunnelProcess.kill('SIGTERM'); 
            this.tunnelProcess = null; 
        }
        
        // 3. Delegate workspace and local directory cleanup to the fixed Provider
        if (this.provider.region) {
            this.log(`Delegating workspace cleanup to the execution provider...`);
            try {
                // This will now correctly execute the remote 'rm -rf' and clean up local dirs
                await this.provider.cleanupSandbox();
            } catch (error: any) {
                this.log(`Provider cleanup failed: ${error.message}`);
            }
        }
    }
}