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

import { E2BAgentEnvironment } from "./agentEnvironmentProviders/E2BAgentEnvironment.js";
import { FilePayload } from "./executionProvider.js";
import { DistributedAgentType, MultiAgentToolContext, ToolExecutionEnvironmentType } from '../momoa_core/types.js';
import { CloudRunAgentEnvironment } from "./agentEnvironmentProviders/CloudRunAgentEnvironment.js";
import { getGeminiCLIAgentConfig } from "./agentEnvironmentProviders/agentConfigs/geminiCLIAgentConfig.js";
import { CloudWorkstationAgentEnvironment } from "./agentEnvironmentProviders/CloudWorkstationAgentEnvironment.js";
import { LocalDockerAgentEnvironment } from "./agentEnvironmentProviders/LocalDockerAgentEnvironment.js";
import { JulesAgentEnvironment } from "./agentEnvironmentProviders/JulesAgentEnvironment.js";
import { getCloudRunIdentityToken } from "../utils/cloudRunAuth.js";

export interface AgentConfig {
  files?: FilePayload[];
  agentName: string;
  command: string;
  authMethodId?: string;
  envs?: Record<string, string>;
  installer?: string;
}

export interface AgentSession {
    sessionId: string;
    connectionUrl: string; // The HTTP/WS endpoint (e.g., Durable Stream URL)
    
    // Core interaction methods
    sendMessage: (data: any) => Promise<void>;
    
    // Streaming callbacks
    onMessage: (handler: (data: any) => void) => void;
    onError: (handler: (error: Error) => void) => void;
    
    // Lifecycle
    wait: () => Promise<void>;
    kill: () => Promise<void>;
}

export interface AgentEnvironment {
    providerName: string;
    
    getAgentName(): string;

    // 1. Prepare the environment (clone repo, install runner scripts)
    provision(files?: FilePayload[], additionalDependencyInstallCommand?: string): Promise<void>;
    
    // 2. Spawn the agent process and establish the stream
    startSession(timeout?: number): Promise<AgentSession>;
    
    // 3. Clean up the environment
    teardown(): Promise<void>;
}

export async function getAgentEnvironment(context: MultiAgentToolContext): Promise<AgentEnvironment> {
    
    let agentConfig;

    if (context.distributedAgent === DistributedAgentType.GeminiCLI)
      agentConfig = getGeminiCLIAgentConfig(context);
    else
      throw new Error(`Requested Agent (${context.distributedAgent}) is not supported.`);

    switch (context.toolExecutionEnvironment) {
        case ToolExecutionEnvironmentType.E2B:
            if (!context.secrets.e2BApiKey) {
                throw new Error("Missing E2B API Key.");
            }
            return new E2BAgentEnvironment(context.secrets.e2BApiKey, agentConfig);

        case ToolExecutionEnvironmentType.CloudWorkstation:
            if (!context.secrets.gcpProjectId ||
                !context.secrets.cloudWorkstationName)
                throw new Error("Missing Cloud Workstation access data.");
            return new CloudWorkstationAgentEnvironment(
                context.secrets.googleAccessToken, 
                context.secrets.gcpProjectId, 
                context.secrets.cloudWorkstationName, agentConfig);
            
        case ToolExecutionEnvironmentType.CloudRun:
            const cloudRunUrl = context.secrets.cloudRunProxyUrl;
            
            if (!cloudRunUrl) {
                throw new Error("Missing Cloud Run Proxy URL. Please provide it via --cloud-run-proxy-url or set the CLOUD_RUN_URL environment variable.");
            }
        
            const token = context.secrets.cloudRunToken || await getCloudRunIdentityToken(cloudRunUrl);

            return new CloudRunAgentEnvironment(agentConfig, cloudRunUrl, token);
         
        case ToolExecutionEnvironmentType.Jules:
            return new JulesAgentEnvironment(context);
            
        case ToolExecutionEnvironmentType.Local:
        default:
            // Fallback to local Docker if no specific remote agent environment is configured
            return new LocalDockerAgentEnvironment(agentConfig, context.secrets.localDockerImage, context.secrets.dockerMounts, context.secrets.dockerNetwork);
    }
}