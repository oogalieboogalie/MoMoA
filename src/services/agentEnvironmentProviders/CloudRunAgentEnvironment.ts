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

import { randomUUID } from 'crypto';
import { DurableStream } from '@durable-streams/client';
import { 
    AgentEnvironment, 
    AgentConfig, 
    AgentSession 
} from '../agentEnvironmentProvider.js';
import { FilePayload } from '../executionProvider.js';
import { RUNNER_SCRIPT_FILES, STUB_FILES } from '../acpSandbox.js';

export class CloudRunAgentEnvironment implements AgentEnvironment {
    providerName = "Cloud Run Agent Environment";
    
    private serviceUrl: string;
    private identityToken: string; 
    private sessionId: string; // Now generated immediately
    private activeStreamUrl: string | null = null;
    private affinityCookie: string | null = null; // Stores the GCRAffinity routing cookie
    private unsubscribeStream: (() => void) | null = null;

    constructor(private agentConfig: AgentConfig, serviceUrl: string, identityToken: string) {
        this.serviceUrl = serviceUrl.replace(/\/$/, ""); 
        this.identityToken = identityToken;
        this.sessionId = randomUUID(); // Generate upfront so provision() can use it
    }

    getAgentName(): string {
        return this.agentConfig.agentName;
    }

    // Helper to inject the token and the sticky cookie into every request
    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.identityToken}`
        };
        if (this.affinityCookie) {
            headers['Cookie'] = this.affinityCookie;
        }
        return headers;
    }

    private provisionPayload: any = null;

    async provision(files?: FilePayload[], additionalDependencyInstallCommand?: string): Promise<void> {
        console.log(`[CloudRunOrchestrator] Queuing workspace files for ${this.sessionId}...`);
        
        const runnerFiles: FilePayload[] = [...RUNNER_SCRIPT_FILES, ...STUB_FILES];
        const projectFiles: FilePayload[] = [...(files || []), ...(this.agentConfig.files || [])];

        const installCommands: string[] = ["npm install"];
        // if (this.agentConfig.installer) installCommands.push(this.agentConfig.installer);
        if (additionalDependencyInstallCommand) installCommands.push(additionalDependencyInstallCommand);

        // Defer the network request. Just save the payload for the start step.
        this.provisionPayload = { projectFiles, runnerFiles, installCommands };
    }

    async startSession(_timeout: number): Promise<AgentSession> {
        console.log(`[CloudRunOrchestrator] Sending atomic start request for session ${this.sessionId}...`);

        const envArgs = Object.entries(this.agentConfig.envs || {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        const authArgs = this.agentConfig.authMethodId ? ["--authMethodId", this.agentConfig.authMethodId] : [];
        
        const runnerArgs = [
            `/tmp/runner/${this.sessionId}/session-runner.js`, 
            // "--raw",
            "--cmd",
            this.agentConfig.command,
            ...authArgs,
            ...envArgs
        ];

        const response = await fetch(`${this.serviceUrl}/v1/start`, {
            method: 'POST',
            headers: this.getHeaders(), // (Your standard Authorization headers)
            body: JSON.stringify({
                sessionId: this.sessionId,
                command: "node",        
                args: runnerArgs,       
                envs: this.agentConfig.envs,
                // Inject the provision payload so it all happens at once
                files: this.provisionPayload?.projectFiles || [],
                runnerFiles: this.provisionPayload?.runnerFiles || [],
                installCommands: this.provisionPayload?.installCommands || []
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to start: ${response.status} - ${await response.text()}`);
        }

        const responseData = (await response.json()) as {
            success: boolean;
            directRouteIp?: string;
            internalPort?: number;
        };

        // THE FIX: Connect directly to the specific container instance's IP, bypassing the Load Balancer!
        // Cloud Run allows internal IP routing if the requests originate from within the same VPC.
        const routingHost = responseData.directRouteIp && responseData.directRouteIp !== "localhost" 
            ? `http://${responseData.directRouteIp}:8080` // Route to the proxy's main port on that specific instance
            : this.serviceUrl;

        this.activeStreamUrl = `${routingHost}/v1/stream/messages?sessionId=${this.sessionId}`;

        console.log(`[CloudRunOrchestrator] Connecting to stream at direct route: ${this.activeStreamUrl}`);

        const ds = new DurableStream({ 
            url: this.activeStreamUrl, 
            contentType: "application/json", 
            headers: this.getHeaders() // Don't forget the auth headers!
        });

        let isPolling = false;
        let onMessageHandler: ((data: any) => void) | null = null;
        let onErrorHandler: ((err: Error) => void) | null = null;
        let isSessionActive = true;

        return {
            sessionId: this.sessionId,
            connectionUrl: this.activeStreamUrl,

            sendMessage: async (data: any) => {
                if (!isSessionActive) throw new Error("Session is terminated.");
                
                // 1. Prepare the plain JSON payload
                const payload = { ...data, _source: "client", sessionId: this.sessionId };
                
                // 2. Use a standard fetch POST instead of the Durable Stream client.
                // This prevents the 409 Conflict header clashes and format mismatches.
                if (this.activeStreamUrl) {
                    const response = await fetch(this.activeStreamUrl, {
                        method: 'POST',
                        headers: this.getHeaders(), // This already includes Content-Type: application/json and Auth
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        console.error(`[CloudRunOrchestrator] Failed to send message: ${response.status}`);
                    }
                } else 
                    console.error(`[CloudRunOrchestrator] Failed to send message: No Active Stream URL`);
            },

            onMessage: (handler) => {
                onMessageHandler = handler;
                if (!isPolling) {
                    isPolling = true;
                    ds.stream({ live: true }).then(streamRes => {
                        // THE FIX: Capture the unsubscribe function so we can stop the loop later
                        this.unsubscribeStream = streamRes.subscribeJson((batch: any) => {
                            if (onMessageHandler) {
                                batch.items.forEach((item: any) => {
                                    if (item._source === "runner" && item.status === "exited") {
                                        isSessionActive = false; 
                                        onMessageHandler!({ method: "agent_ready" }); 
                                    }
                                    onMessageHandler!(item);
                                });
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
                return new Promise((resolve) => {
                    const checkInterval = setInterval(async () => {
                        if (!isSessionActive) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 1000);
                });
            },

            kill: async () => {
                console.log(`[CloudRunOrchestrator] Best-effort kill for session ${this.sessionId}...`);
                // isSessionActive = false;
                
                // Fire and forget. If it hits the right container, great. If not, the proxy's timeout handles it.
                await fetch(`${this.serviceUrl}/v1/kill`, {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify({ sessionId: this.sessionId })
                }).catch(e => console.warn(`[CloudRunOrchestrator] Kill ping dropped (expected serverless routing behavior):`, e.message));
            }
        };
    }

async teardown(): Promise<void> {
    console.log(`[CloudRunOrchestrator] Best-effort teardown for session ${this.sessionId}...`);
    
    // THE FIX: Politely hang up the phone from the client side FIRST.
    // This permanently stops the background loop and prevents the 404 crash.
    if (this.unsubscribeStream) {
        this.unsubscribeStream();
        this.unsubscribeStream = null;
    }

    if (this.sessionId) {
        try {
            await fetch(`${this.serviceUrl}/v1/teardown`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ sessionId: this.sessionId }),
                signal: AbortSignal.timeout(5000)
            });
        } catch (e: any) {
            console.warn(`[CloudRunOrchestrator] Teardown ping dropped or timed out:`, e.message);
        }
        
        this.activeStreamUrl = null;
    }
}
}