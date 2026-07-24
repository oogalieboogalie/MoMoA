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

import { MultiAgentToolContext } from "../../../momoa_core/types.js";
import { AgentConfig } from "../../agentEnvironmentProvider.js";

/**
 * GeminiCLI-specific runner and config
 */
export type GeminiCLISandboxConfig = { apiKey: string };

export function getGeminiCLIAgentConfig(context: MultiAgentToolContext): AgentConfig {
  const secrets = context.secrets;
  const apiKey  = secrets.geminiApiKey;
  if (!apiKey) throw new Error("apiKey is required");

  return {
    agentName: "Gemini CLI",
    installer: "npm install @google/gemini-cli --no-audit --no-fund",
    authMethodId: "gemini-api-key",
    command: "gemini --experimental-acp",
    envs: { GEMINI_API_KEY: apiKey },
  };
}
