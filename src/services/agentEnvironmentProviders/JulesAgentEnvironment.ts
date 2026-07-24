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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { SimpleGit, simpleGit } from 'simple-git';

import { 
    AgentEnvironment, 
    AgentSession 
} from '../agentEnvironmentProvider.js';
import { 
    MultiAgentToolContext,
    SWARM_CLIENT_METHODS,
    VerbosityType 
} from '../../momoa_core/types.js';
import { FilePayload } from '../../services/executionProvider.js';
import { 
    JulesAPIService, 
    JulesSessionState, 
    formatActivityContent 
} from '../../services/julesService.js';

export class JulesAgentEnvironment implements AgentEnvironment {
    private JULES_SCRATCHPAD_REPO_URL = ({ githubToken, repo }: { githubToken: string; repo: string }) => 
      `https://${githubToken}@github.com/${repo}.git`;
    
    private JULES_POLLING_TIMEOUT_MS = 10 * 60 * 1000;

    providerName = "Jules Agent Environment";

    private julesService!: JulesAPIService;
    private sessionKilled = false;
    private julesSessionName?: string;

    private updateProgress = (message: string | Promise<string>) => {
      this.context.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: message
      });
    }
        
    constructor(
      private context: MultiAgentToolContext
    ) {}

    getAgentName(): string {
        return "Jules";
    }

    async provision(): Promise<void> {
      if (!this.context.secrets.julesApiKey) {
        this.updateProgress("Error: User has not provided a Jules API Key. Jules cannot be used.");
        throw new Error(`Error: User has not provided a Jules API Key. Jules cannot be used.`);
      }

      let branch: string;

      if (!this.context.secrets.githubScratchPadRepo || !this.context.secrets.githubToken) {
        if (!this.context.secrets.githubScratchPadRepo)
          this.updateProgress("User hasn't provided a scratchpad. Jules requires access to a Github repo.");
        if (!this.context.secrets.githubToken)
          this.updateProgress("User hasn't provided a Github Access Token. Jules requires access to a Github repo.");

        throw new Error(`Error: User has not provided access to a Github repo connected to Jules.`);
      } else {
        try {
          const isFirstRun = !this.context.julesBranchName;
          if (isFirstRun) {
            const timestamp = new Date().getTime();
            this.context.julesBranchName = `jules-scratchpad/${timestamp}`;
            this.updateProgress(`Creating new GitHub scratchpad branch: ${this.context.julesBranchName}`);

            await this.sendFilesToGHScratpad(true);
            this.updateProgress(`Pushed all project files to Github scratchpad branch.`);
          } else {
            if (this.context.julesBranchName) {
              await this.sendFilesToGHScratpad(false);
              this.updateProgress(`Pushed ${this.context.editedFilesSet.size} modified file(s) to ${this.context.julesBranchName}.`);
            } else {
              this.updateProgress(`Failed to use scratchpad branch (not defined)`);
            }
          }
        } catch (error: any) {
          const errorMessage = `Error: Failed to prepare GitHub scratchpad branch: ${error.message}`;
          this.updateProgress(errorMessage);
          throw new Error(errorMessage);
        }
      }

      branch = this.context.julesBranchName ?? '';
      if (!branch) {
        throw new Error("GitHub Scratchpad Branch was not created.");
      }
    }

    async startSession(_timeout?: number): Promise<AgentSession> {
        this.julesService = new JulesAPIService(this.context.secrets.julesApiKey!);
        
        let messageHandlers: ((data: any) => void)[] = [];
        let errorHandlers: ((error: Error) => void)[] = [];
        let isPolling = false;
        
        const emitMessage = (data: any) => messageHandlers.forEach(h => h(data));
        const emitError = (error: Error) => errorHandlers.forEach(h => h(error));

        const session: AgentSession = {
            sessionId: randomUUID(),
            connectionUrl: 'jules://polling',
            onMessage: (handler) => messageHandlers.push(handler),
            onError: (handler) => errorHandlers.push(handler),
            wait: async () => {
                while (!this.sessionKilled) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            },
            kill: async () => {
                this.sessionKilled = true;
            },
            sendMessage: async (data: any) => {
                const message = data.params?.message;
                if (!message) return;

                if (!this.julesSessionName) {
                    // Start the initial Jules session mapping to the supervisor's first prompt
                    try {
                        const projectsResult = await this.julesService.getProjects();
                        if ('error' in projectsResult) throw new Error(projectsResult.error);

                        const [scratchOwner, scratchRepoName] = this.context.secrets.githubScratchPadRepo!.split('/');
                        const scratchSource = projectsResult.find(p => p.githubRepo.owner === scratchOwner && p.githubRepo.repo === scratchRepoName);

                        if (!scratchSource) throw new Error(`Could not find a Jules source matching '${this.context.secrets.githubScratchPadRepo}'.`);

                        const sessionResult = await this.julesService.createSession(message, scratchSource.name, this.context.julesBranchName!);
                        if ('error' in sessionResult) throw new Error(sessionResult.error);

                        this.julesSessionName = sessionResult.name;

                        const sessionUrl = sessionResult.url || '';
                        this.updateProgress(`Jules session created. You can track progress at ${sessionUrl}`);

                        // emitMessage({ method: SWARM_CLIENT_METHODS.agent_ready });
                        
                        // Fire off the background polling loop
                        if (!isPolling) {
                            isPolling = true;
                            this.pollJules(this.julesSessionName, emitMessage, emitError);
                        }
                    } catch (e: any) {
                        emitError(e);
                    }
                } else {
                    // Pipe the supervisor LLM's replies back to Jules' AWAITING_USER_FEEDBACK prompt
                    await this.julesService.postUserMessage(this.julesSessionName, message);
                }
            }
        };

        setTimeout(() => {
            emitMessage({ method: SWARM_CLIENT_METHODS.agent_ready });
        }, 0);

        return session;
    }

    async teardown(): Promise<void> {
        this.sessionKilled = true;
    }

    private async pollJules(sessionName: string, emitMessage: (data: any) => void, emitError: (error: Error) => void) {
        let lastUpdateTime = Date.now();
        const processedActivityIds = new Set<string>();
        const repliedActivityIds = new Set<string>();
        let isTaskComplete = false;

        while (!this.sessionKilled && !isTaskComplete) {
            if (Date.now() - lastUpdateTime > this.JULES_POLLING_TIMEOUT_MS) {
                emitMessage({
                    params: { update: { sessionUpdate: "agent_log", content: { text: `[Timeout]: Jules session timed out after unresponsiveness.\n` } } }
                });
                break;
            }

            // Polling interval
            await new Promise(r => setTimeout(r, 10000));

            const sessionUpdate = await this.julesService.getSession(sessionName);
            if ('error' in sessionUpdate) continue;
            const session = sessionUpdate;

            const activitiesResult = await this.julesService.listActivities(sessionName);
            if ('error' in activitiesResult) continue;

            let needsEndTurn = false;
            let sessionFailed = false;

            // Handle Jules explicitly yielding for feedback
            if (session.state === JulesSessionState.AWAITING_USER_FEEDBACK) {
                const lastQuestion = [...activitiesResult].reverse().find(a => a.agentMessaged);
                if (lastQuestion && !repliedActivityIds.has(lastQuestion.id)) {
                    repliedActivityIds.add(lastQuestion.id);
                    processedActivityIds.add(lastQuestion.id);
                    lastUpdateTime = Date.now();

                    const message = lastQuestion.agentMessaged!.agentMessage;
                    
                    emitMessage({
                        params: { update: { sessionUpdate: "agent_log", content: { text: `[Jules asks]: ${message}\n` } } }
                    });
                    
                    // Trigger the supervisor ReAct logic in `agentTool.ts`
                    needsEndTurn = true;
                }
            }

            // Flush standard logs
            for (const activity of activitiesResult) {
                if (processedActivityIds.has(activity.id)) continue;
                processedActivityIds.add(activity.id);
                lastUpdateTime = Date.now();

                if (activity.sessionFailed) {
                    sessionFailed = true;
                    emitMessage({
                        params: { update: { sessionUpdate: "agent_log", content: { text: `[Jules Failed]: ${activity.sessionFailed.reason}\n` } } }
                    });
                }

                const formattedLog = await formatActivityContent(activity, VerbosityType.AISummarize, this.context.multiAgentGeminiClient, "Jules Task");
                emitMessage({
                    params: { update: { sessionUpdate: "agent_log", content: { text: `${formattedLog}\n` } } }
                });
            }

            if (session.state === JulesSessionState.COMPLETED) {
                isTaskComplete = true;
                await this.fetchChangesFromJules(sessionName, emitMessage);
                needsEndTurn = true;
            } else if (sessionFailed) {
                isTaskComplete = true;
                needsEndTurn = true;
            }

            if (needsEndTurn) {
                emitMessage({
                    _source: "runner",
                    result: { stopReason: "end_turn" }
                });
            }
        }
        
        this.sessionKilled = true;
    }

    /**
     * Bridges Jules' remote API artifacts to the CLI interface's payload.
     * Extracts unified diffs and explicit binary media directly from the session activities.
     */
    private async fetchChangesFromJules(sessionName: string, emitMessage: (data: any) => void) {
        const allActivities = await this.julesService.listActivities(sessionName);
        let combinedPatch = "";
        const filesPayload: FilePayload[] = [];

        if (!('error' in allActivities)) {
            allActivities.forEach(activity => {
                activity.artifacts?.forEach(artifact => {
                    // 1. Extract text patches for applyDiff
                    const patchStr = artifact.changeSet?.gitPatch?.unidiffPatch;
                    if (patchStr) {
                        combinedPatch += (combinedPatch ? '\n' : '') + patchStr;
                    }

                    // 2. Extract media/binary data directly from Jules artifacts
                    if (artifact.media) {
                        const filename = activity.description.split(' ').pop(); 
                        if (filename) {
                            filesPayload.push({
                                path: filename.trim(),
                                content: artifact.media.data, // Already base64 encoded by the API
                                isBinary: true
                            });
                        }
                    }
                });
            });
        }

        // Emit the unified text patch so agentTool can use applyDiff natively
        if (combinedPatch.trim()) {
            emitMessage({
                method: SWARM_CLIENT_METHODS.git_patch,
                params: { patch: combinedPatch }
            });
        }

        // Emit any binary files we found directly in the artifacts as workspace_files
        if (filesPayload.length > 0) {
            emitMessage({
                method: 'workspace_files',
                params: { files: filesPayload }
            });
        }
    }

    async sendFilesToGHScratpad(isFirstRun: boolean): Promise<void> {
      let {
        secrets,
        julesBranchName: branchName,
        fileMap,
        binaryFileMap,
        editedFilesSet: changedFilesSet,
      } = this.context;
      branchName ||= '';
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'jules-'));
      try {
        const git: SimpleGit = simpleGit(tempDir);
        if (!secrets.githubToken) {
          throw new Error('GITHUB_TOKEN environment variable not set. It is required for private repositories.');
        }
    
        let cloneUrl = this.JULES_SCRATCHPAD_REPO_URL({
          githubToken: secrets.githubToken,
          repo: secrets.githubScratchPadRepo!,
        });
        await git.clone(cloneUrl, tempDir);
    
        if (isFirstRun) {
          await git.checkout(['-b', branchName]);
          for (const [filePath, content] of Array.from(fileMap.entries())) {
            const fullPath = path.join(tempDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
          }
          for (const [filePath, base64Content] of Array.from(binaryFileMap.entries())) {
            const fullPath = path.join(tempDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            const fileBuffer = Buffer.from(base64Content, 'base64');
            await fs.writeFile(fullPath, fileBuffer);
          }
        } else {
          await git.checkout(branchName);
          for (const filePath of Array.from(changedFilesSet)) {
            const fullPath = path.join(tempDir, filePath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            
            if (fileMap.has(filePath)) {
              const content = fileMap.get(filePath) ?? '';
              await fs.writeFile(fullPath, content);
            } else if (binaryFileMap.has(filePath)) {
              const base64Content = binaryFileMap.get(filePath) ?? '';
              const fileBuffer = Buffer.from(base64Content, 'base64');
              await fs.writeFile(fullPath, fileBuffer);
            }
          }
        }
    
        await git.add('./*');
        const commitMessage = isFirstRun ? 'Initial commit for Jules session' : 'Update files for Jules session';
        const commitResult = await git.commit(commitMessage);
    
        if (commitResult.commit) {
          if (isFirstRun) {
            await git.push('origin', branchName, ['--set-upstream']);
          } else {
            await git.push('origin', branchName);
          }
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
}