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

import { MultiAgentTool } from '../multiAgentTool.js';
import { MultiAgentToolContext, MultiAgentToolResult, SWARM_CLIENT_METHODS, ToolExecutionEnvironmentType, ToolParsingResult } from '../../momoa_core/types.js';
import { getAssetString, replaceRuntimePlaceholders } from '../../services/promptManager.js';
import { DEFAULT_GEMINI_PRO_MODEL, DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_LITE_MODEL } from '../../config/models.js';
import { removeBacktickFences } from '../../utils/markdownUtils.js';
import { applyDiff, isLockFile } from '../../utils/diffGenerator.js';
import { 
  addDynamicallyRelevantFile,
  getFileAnalysis,
  removeFileEntry,
  updateFileEntry 
} from '../../utils/fileAnalysis.js';
import { parsePatch, createTwoFilesPatch } from 'diff';
import { GeminiClient } from '../../services/geminiClient.js';
import { Buffer } from 'node:buffer';
import { AgentSession, getAgentEnvironment } from '../../services/agentEnvironmentProvider.js';
import { deferred } from '../../utils/promises.js';
import { FilePayload } from '../../services/executionProvider.js';
import { executeTool } from '../multiAgentToolRegistry.js';

const LARGE_FILE_LIMIT_KB = 100;
const MAX_PATCH_LENGTH = LARGE_FILE_LIMIT_KB * 1000;

export const agentTool: MultiAgentTool = {
  displayName: "Agent CLI Tool",
  name: 'SDLC_AGENT',
  
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    const request = invocation.slice(1).slice(0, -1).trim();
    if (!request) {
      return { success: false, error: "A natural language request is required." };
    }
    return { success: true, params: { request } };
   },

  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const { request } = params;

    if (context.toolExecutionEnvironment === ToolExecutionEnvironmentType.Jules) {
        return executeTool('JULES{', params, context);
    }

    return runAgent(request, context, this.displayName);
  }
}

async function summarizeToolOutput(logs: string, geminiClient: GeminiClient): Promise<string> {
  try {
    const prompt = await replaceRuntimePlaceholders(await getAssetString("bash-summarizer"), {
      BashOutput: logs,
    })
    
    const summarizedBash = (await geminiClient.sendOneShotMessage(
      prompt,
      { model: DEFAULT_GEMINI_LITE_MODEL }
    ))?.text || logs;

    const cleansummarizedBash = removeBacktickFences(summarizedBash);
    return cleansummarizedBash;

  } catch {
    return logs;
  }
}

// --- Helper: Format ACP Protocol Messages for Human Logs ---
async function formatACPMessage(data: any, geminiClient: GeminiClient): Promise<{ text: string; type: string; } | null> {
    if (!data) return null;

    if (!data.params) return null;

    if (data.params.update?.sessionUpdate === "agent_log") {
        const text = data.params.update.content?.text;
        if (text) return { text: text, type: data.params.update?.sessionUpdate};
    }

    if (data.params.update?.sessionUpdate === "agent_message_chunk") {
        const text = data.params.update.content?.text;
        if (text) return { text: text, type: data.params.update?.sessionUpdate};
    }

    if (data.params.update?.sessionUpdate === "agent_thought_chunk") {
        const text = data.params.update.content?.text;
        if (text) return { text: `${text}`, type: data.params.update?.sessionUpdate }; 
    }

    if (data.params.update?.sessionUpdate === "tool_call") {
        const title = data.params.update.title || "Tool Call";
        const toolName = data.params.update?.content[0]?._meta?.kind || "Tool";
        const capitalizedToolName = toolName.charAt(0).toUpperCase() + toolName.slice(1);
        return { text: `\n>[${capitalizedToolName}] ${title}\n`, type: data.params.update.sessionUpdate };
    }

    if (data.params.toolCall) {
        const title = data.params.toolCall.title || "Tool Call";
        return { text: `\n>${title}\n`, type: data.params.update?.sessionUpdate };
    }

    if (data.params.update?.sessionUpdate === "tool_call_update") {
      const content = data.params.update.content?.[0]?.content?.text;

      if (content) {
        const summarizedToolResult = await summarizeToolOutput(content, geminiClient);
        return { text: `\n\`\`\`\n${summarizedToolResult}\n\`\`\`\n`, type: data.params.update?.sessionUpdate };
      }
    }

    return null;
}

export async function runAgent(request: string, context: MultiAgentToolContext, toolName: string, additionalDependencyInstallCommand?: string): Promise<MultiAgentToolResult> {
    const fullLogForSummary: string[] = [];
    const sessionTranscript: string[] = [];
    let latestPatch = ""; 
    let isTaskComplete = false;
    const sweptFiles: Map<string, FilePayload> = new Map<string, FilePayload>();

    const updateLog = (message: string) => {
      context.sendMessage(JSON.stringify({ status: 'WORK_LOG', message }));
      fullLogForSummary.push(message);
    };

    const updateProgress = (message: string | Promise<string>) => {
      context.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: message
      });
    }

    if (!context.secrets.geminiApiKey) return { result: "Error: Missing Gemini API Key." };

    // --- 1. Prepare File Payload ---
    updateLog("Staging local files for sandbox injection...");
    updateProgress(`Staging ${context.fileMap.entries.length + context.binaryFileMap.entries.length} files.`);
    
    const filesPayload: FilePayload[] = [];
    for (const [filePath, content] of context.fileMap.entries()) {
        filesPayload.push({
            path: filePath,
            content: Buffer.from(content).toString('base64'),
            isBinary: false
        });
    }
    for (const [filePath, b64Content] of context.binaryFileMap.entries()) {
        filesPayload.push({ path: filePath, content: b64Content, isBinary: true });
    }

    // --- 2. Provision and Start Orchestrator ---
    const agentEnvironment = await getAgentEnvironment(context);
    if (!agentEnvironment) 
        return { result: "No Agent Environment is available."}
    
    const { promise: agentReadyPromise, resolve: agentReady } = deferred<void>();
    
    let session: AgentSession;
    try {
        // Provision the Agent Environment
        updateProgress(`Provisioning ${agentEnvironment.providerName} sandbox for ${agentEnvironment.getAgentName()}.`);
        await agentEnvironment.provision(filesPayload, additionalDependencyInstallCommand);

        // Start a new Agent Session in the Agent Environment
        updateProgress(`Starting ${agentEnvironment.getAgentName()} in ${agentEnvironment.providerName}.`);
        session = await agentEnvironment.startSession();

    } catch (e: any) {
        return { result: `Failed to initialize agent environment: ${e.message}` };
    }

    // Handle aborts gracefully
    if (context.signal) {
        context.signal.addEventListener('abort', async () => {
            updateLog("Received abort signal. Cancelling.");
            updateProgress("Received abort signal. Cancelling");
            await session.kill();
        });
    }

    // --- State for Log Consolidation ---
    let bufferedLog = "";

    const flushLogs = async () => {
      if (bufferedLog) {
        updateLog(bufferedLog);
        
        let progressUpdateMessage = bufferedLog;
        const completed_status_message_prompt = await replaceRuntimePlaceholders(await getAssetString("summarize-progress-start"), {
          LastOrchestratorResponse: bufferedLog
        });
        
        try {
          progressUpdateMessage = (await context.multiAgentGeminiClient.sendOneShotMessage(
            completed_status_message_prompt,
            { model: DEFAULT_GEMINI_LITE_MODEL, signal: context.signal } // NEW: Pass signal
          ))?.text || bufferedLog;
        } catch (_error) {}
        updateProgress(progressUpdateMessage);

        sessionTranscript.push(bufferedLog);
        bufferedLog = "";
      }
    };

    session.onMessage(async (data: any) => {
        try {
            if (data.method === 'workspace_files' && data.params?.files) {
                for (const file of data.params.files) {
                    sweptFiles.set(file.path, file); 
                }
                updateLog(`Found ${data.params.files.length} changed workspace files.`);
                updateProgress(`Received ${data.params.files.length} changed files.`);
            }

            if (data.method === SWARM_CLIENT_METHODS.agent_ready) {
                agentReady();
            }
          
            if (data.method === SWARM_CLIENT_METHODS.git_patch && data.params?.patch) {
                latestPatch = data.params.patch;
            }

            if (data.error?.data?.details === 'Model stream ended with empty response text.') {
                isTaskComplete = true;
                await session.kill();
                return; 
            }

            const logEntry = await formatACPMessage(data, context.multiAgentGeminiClient);
            if (logEntry) {
                if (logEntry.type === "agent_message_chunk" || logEntry.type === "agent_thought_chunk") {
                    bufferedLog += logEntry.text;
                } else {
                    await flushLogs();
                    updateLog(logEntry.text);
                    if (logEntry.type !== "tool_call_update")
                        updateProgress(logEntry.text);
                    sessionTranscript.push(logEntry.text);
                }
            }

            if (data.status === "failed") {
                await flushLogs();
                updateLog(`CRITICAL ERROR: ${data.summary}`);
                await session.kill(); 
            }

            if (data._source === "runner" && data.result?.stopReason === "end_turn") {
                await flushLogs();
                if (!isTaskComplete)
                    isTaskComplete = await checkCompletionAndReply(request, sessionTranscript, session, agentEnvironment.getAgentName(), context, toolName, updateProgress);
            }
        } catch (e) {
            console.error("Error processing agent message", e);
        }
    });

    // --- 5. Execution Execution ---
    try {
        await agentReadyPromise;
        updateLog("Agent Ready. Sending request...");
        
        let finalRequest = request;

        await session.sendMessage({
            _source: 'client',
            method: 'chat', 
            params: { message: finalRequest }
        });

        // Block until the session is killed by the Supervisor or an error
        await session.wait();
        await flushLogs();

    } catch (e: any) {
        await flushLogs();
        updateLog(`Sandbox execution ended: ${e.message}`);
    } finally {
        // Always clean up the environment when done
        await agentEnvironment.teardown();
    }

    // --- 4. Summarize Logs ---
    updateLog("Generating session summary...");
    let summarizerPrompt = await getAssetString("log-summarizer");
    summarizerPrompt = await replaceRuntimePlaceholders(summarizerPrompt, {
      LogContent: fullLogForSummary.join("\n"),
      UnifiedDiff: latestPatch || "---No files changed---", 
    });

    const summarizedResponse = (await context.multiAgentGeminiClient.sendOneShotMessage(
      summarizerPrompt,
      { model: DEFAULT_GEMINI_PRO_MODEL }
    ))?.text || '';
    const cleanSummary = removeBacktickFences(summarizedResponse);
    
    const diffApplicationLog = await reviewFileChanges(context, toolName, sweptFiles, latestPatch, request, sessionTranscript, updateProgress);

    // --- 6. Result ---
    let finalResultString = `
${toolName} has completed the session.

**Log Summary:**
${cleanSummary}

**File Changes:**
${diffApplicationLog}
`.trim();

    return { 
        result: finalResultString 
    };
}

async function checkCompletionAndReply(request: string, sessionTranscript: string[], session: AgentSession, agentName: string, context: MultiAgentToolContext, toolName: string, updateProgress: { (message: string | Promise<string>): void; (message: string): void; }): Promise<boolean> {
    // If we already decided to complete, ignore subsequent triggers
    // if (isTaskComplete) return;

    let isTaskComplete = false;

    updateProgress("Agent finished turn. Consulting Supervisor...");

    const prompt = `
--- ORIGINAL TASK ---
${request}

--- SESSION TRANSCRIPT ---
${sessionTranscript.join("\n\n")}

--- INSTRUCTIONS ---
Is the task fully completed based on the transcript above?
1. If the agent is asking a question or needs clarification, it is NOT complete.
2. If the agent says "I have finished" or similar, and it seems reasonable, it is COMPLETE.
3. If the agent is stuck or providing incomplete info, provide guidance.
4. If the agent is stuck in a repeating loop, it is COMPLETE.

Respond with JSON:
{
"complete": boolean,
"reply_to_agent": "Your message to the agent here (if not complete)",
"reasoning": "Why you made this decision"
}
`;
    
    try {
        const response = await context.multiAgentGeminiClient.sendOneShotMessage(prompt, { model: DEFAULT_GEMINI_FLASH_MODEL });
        const resultText = removeBacktickFences(response?.text || "{}");
        const decision = JSON.parse(resultText);

        updateProgress(`${toolName} Supervisor says the work is ${decision.complete ? "completed" : "ongoing"}. ${decision.reasoning}`);

        if (decision.complete) {
            updateProgress("Task marked complete. Proceeding to Diff Review...");
            isTaskComplete = true;
            await session.kill(); // Stop the agent to proceed to the diff review
        } else {
            if (decision.reply_to_agent) {
                updateProgress(`Replied to ${agentName}: ${decision.reply_to_agent}`);
                sessionTranscript.push(`[Supervisor] ${decision.reply_to_agent}`);
                await session.sendMessage({
                    _source: 'client',
                    method: 'chat',
                    params: { message: decision.reply_to_agent }
                });
            } else {
                await session.kill();
            }
        }
    } catch (e: any) {
        updateProgress(`Error in Supervisor loop: ${e.message}. Aborting.`);
        await session.kill();
    }
    return isTaskComplete;
}

async function reviewFileChanges(context: MultiAgentToolContext, toolName: string, sweptFiles: Map<string, FilePayload>, latestPatch: string, request: string, sessionTranscript: string[], updateProgress: { (message: string | Promise<string>): void; (message: string): void; }): Promise<string> {

    let diffApplicationLog = "No changes were applied based on the review decision.";

    if (sweptFiles.size > 0 || latestPatch) { 
        updateProgress(`Generating unified diff for review...`);
        let generatedPatch = "";
        
        // 1. Preserve Deletions and Renames from the agent's native git_patch
        if (latestPatch) {
            const filePatches = latestPatch.split(/(?=^diff --git )/m);
            for (const chunk of filePatches) {
                if (!chunk.trim()) continue;
                const parsed = parsePatch(chunk);
                let shouldKeep = false;

                if (parsed.length > 0 && parsed[0].hunks.length > 0) {
                    const p = parsed[0];
                    const isDeletion = p.newFileName === '/dev/null';
                    const isRename = p.oldFileName !== p.newFileName && !isDeletion && p.oldFileName !== '/dev/null';
                    const targetFile = p.newFileName?.replace(/^b\//, '');
                    
                    // Keep if it's a deletion, rename, or if sweptFiles doesn't already have it
                    if (isDeletion || isRename || (targetFile && !sweptFiles.has(targetFile))) {
                        shouldKeep = true;
                    }
                } else {
                    // Keep unparseable chunks (like raw binary diffs) just in case
                    shouldKeep = true; 
                }

                if (shouldKeep) {
                    generatedPatch += chunk + "\n";
                }
            }
        }

        // 2. Append swept files for accurate content modifications
        for (const file of sweptFiles.values()) { 
            const fname = file.path;
            generatedPatch += `diff --git a/${fname} b/${fname}\n`;
            
            if (file.isBinary) {
                generatedPatch += `Binary files a/${fname} and b/${fname} differ\n`;
            } else {
                const oldContent = context.fileMap.get(fname) || "";
                const newContent = Buffer.from(file.content, 'base64').toString('utf8');
                
                const filePatch = createTwoFilesPatch(`a/${fname}`, `b/${fname}`, oldContent, newContent);
                const cleanPatch = filePatch.replace(/^={1,}\n/, '');
                generatedPatch += cleanPatch + "\n";
            }
        }
        latestPatch = generatedPatch; 

        // --- 5. Diff Review & Application (Similar to JulesTool) ---
        let finalResultString = "";
        let diffApplicationLog = "";

        if (!latestPatch || !latestPatch.trim()) {
            diffApplicationLog = "No file changes were produced by the session.";
        } else {
            updateProgress('Asking LLM to review the generated diff...');
            
            // Prepare diff for review (hiding large files)
            // Split by 'diff --git' at the start of a line using lookahead to preserve the split point
            // This ensures files that don't have clean newlines between them are still split correctly
            const filePatches = latestPatch.split(/(?=^diff --git )/m);
            const patchesByFile = new Map<string, string>();
            let diffForReview = '';

            for (let i = 0; i < filePatches.length; i++) {
                let chunk = filePatches[i];
                if (!chunk.trim()) continue; // Skip empty leading chunks
                
                const parsed = parsePatch(chunk);

                if (parsed.length > 0 && parsed[0].hunks.length > 0) {
                    const p = parsed[0];
                    const isDel = p.newFileName === '/dev/null';
                    const fname = (isDel ? p.oldFileName?.replace(/^a\//, '') : p.newFileName?.replace(/^b\//, '')) as string;
                    
                    if (fname) {
                        patchesByFile.set(fname, chunk);
                        if (isLockFile(fname) || chunk.length > MAX_PATCH_LENGTH) {
                            diffForReview += `diff --git a/${fname} b/${fname}\n@@ -0,0 +1 @@\n+ [Large/Lock file changes hidden]\n`;
                        } else {
                            diffForReview += chunk + '\n';
                        }
                    }
                } else {
                    // Check for binary file diff pattern which parsePatch usually skips
                    // Example: "Binary files a/foo.png and b/foo.png differ"
                    const binaryMatch = chunk.match(/Binary files (?:a\/)?(.+) and (?:b\/)?(.+) differ/);
                    // Check for "GIT binary patch" which occurs when full binary data is included
                    const gitBinaryMatch = chunk.includes('GIT binary patch');

                    if (binaryMatch) {
                        const pathA = binaryMatch[1];
                        const pathB = binaryMatch[2];
                        
                        // Determine filename. Prefer pathB (new file), unless it is /dev/null (deleted)
                        let rawName = pathB;
                        if (pathB.includes('/dev/null')) rawName = pathA;
                        
                        // Strip standard git prefixes if present
                        const fname = rawName.replace(/^[ab]\//, ''); 
                        
                        if (fname) {
                            patchesByFile.set(fname, chunk);
                            diffForReview += `diff --git a/${fname} b/${fname}\n@@ -0,0 +1 @@\n+ [Binary file content not shown]\n`;
                        }
                    } else if (gitBinaryMatch) {
                        // Improved regex: Handles potential trailing spaces or different line endings
                        const headerMatch = chunk.match(/^diff --git a\/(.+?)\s+b\/(.+?)\s*$/m);
                        if (headerMatch) {
                            // Use the 'b/' path as the new filename
                            const fname = headerMatch[2].trim();
                            if (fname) {
                                patchesByFile.set(fname, chunk);
                                diffForReview += `diff --git a/${fname} b/${fname}\n@@ -0,0 +1 @@\n+ [GIT binary patch hidden]\n`;
                            }
                        }
                    }
                }
            }

            if (patchesByFile.size > 0)
            updateProgress(`Files being reviewed:\n* ${Array.from(patchesByFile.keys()).join('\n* ')}`);

            const verificationPrompt = `
    You are a Quality Assurance agent reviewing code changes made by an autonomous AI developer.
    --- TASK ---
    ${request}
    --- SESSION TRANSCRIPT ---
    ${sessionTranscript.join("\n").slice(-2000)} ... (truncated)
    --- PROPOSED DIFF ---
    ${diffForReview}
    ---------------------
    Decide if these changes should be applied.
    Options:
    1. **ACCEPT_ALL**: Apply all changes.
    2. **REJECT_ALL**: Apply nothing.
    3. **ACCEPT_PARTIAL**: Apply only specific files.

    Respond with JSON:
    {
    "decision": "ACCEPT_ALL" | "REJECT_ALL" | "ACCEPT_PARTIAL",
    "reasoning": "Explanation...",
    "files_to_apply": ["file1.ts"] 
    }
    `;
            const verificationRes = await context.multiAgentGeminiClient.sendOneShotMessage(verificationPrompt, { model: DEFAULT_GEMINI_PRO_MODEL });
            const verifJson = JSON.parse(removeBacktickFences(verificationRes?.text || "{}"));
            
            const diffToApply: (string|undefined)[] = [];
            if (verifJson.decision === 'ACCEPT_ALL') {
                patchesByFile.forEach((v) => diffToApply.push(v));

                updateProgress(`Accepting all file changes. ${verifJson.reasoning}`);
            } else if (verifJson.decision === 'ACCEPT_PARTIAL') {
                const files = verifJson.files_to_apply || [];
                updateProgress(`Accepting changes to files ${files.join(', ')}. ${verifJson.reasoning}`);
                files.forEach((f: string) => {
                    if (patchesByFile.has(f)) diffToApply.push(patchesByFile.get(f));
                });
            } else {
                updateProgress(`Rejected all suggested file changes. ${verifJson.reasoning}`)
            }

            if (diffToApply.length > 0) {
                const combinedDiff = diffToApply.filter(Boolean).join('\n');
                const applyResult = applyDiff(context.fileMap, combinedDiff);
                const allChangedFiles = new Set<string>();

                if (applyResult.success && applyResult.changes) {
                    
                    // --- 1. Handle Deletions ---
                    for (const filename of applyResult.changes.deleted) {
                        context.editedFilesSet.add(filename);
                        allChangedFiles.add(filename);
                        addDynamicallyRelevantFile(filename);
                        removeFileEntry(filename);
                    }

                    // --- 2. Handle Renames ---
                    for (const rename of applyResult.changes.renamed) {
                        context.editedFilesSet.add(rename.from);
                        context.editedFilesSet.add(rename.to);
                        allChangedFiles.add(rename.from);
                        allChangedFiles.add(rename.to);
                        addDynamicallyRelevantFile(rename.from);
                        addDynamicallyRelevantFile(rename.to);
                        
                        const sourceAnalysis = getFileAnalysis(rename.from);
                        removeFileEntry(rename.from);
                        
                        if (sourceAnalysis) {
                            sourceAnalysis.filename = rename.to;
                            sourceAnalysis.relatedFiles = '';
                            sourceAnalysis.description = `[Moved from ${rename.from} by ${toolName}] ${sourceAnalysis.description || ''}`.trim();
                            await updateFileEntry(rename.to, context.fileMap, undefined, sourceAnalysis);
                        }
                    }

                    // --- 3. Handle Creations & Modifications (Text) ---
                    for (const filename of [...applyResult.changes.created, ...applyResult.changes.modified]) {
                        const isNew = applyResult.changes.created.includes(filename);
                        context.editedFilesSet.add(filename);
                        allChangedFiles.add(filename);
                        addDynamicallyRelevantFile(filename);
                        
                        // applyDiff natively updates context.fileMap, so we just update metadata
                        const analysis = getFileAnalysis(filename) || { filename };
                        const prefix = isNew ? `[Created by ${toolName}]` : `[Modified by ${toolName}]`;
                        analysis.description = `${prefix} ${analysis.description || ''}`.trim();
                        analysis.relatedFiles = '';
                        await updateFileEntry(filename, context.fileMap, undefined, analysis);
                    }

                    // --- 4. Handle Binaries & Large Files (Fallback) ---
                    let filesToApply = new Set<string>();
                    if (verifJson.decision === 'ACCEPT_ALL') {
                        sweptFiles.forEach(f => filesToApply.add(f.path));
                    } else if (verifJson.decision === 'ACCEPT_PARTIAL' && verifJson.files_to_apply) {
                        verifJson.files_to_apply.forEach((f: string) => filesToApply.add(f));
                    }

                    for (const file of sweptFiles.values()) {
                        if (filesToApply.has(file.path)) {
                            const fname = file.path;
                            const existed = !applyResult.changes.created.includes(fname);
                            
                            if (file.isBinary) {
                                context.binaryFileMap.set(fname, file.content);
                                context.fileMap.delete(fname);
                                context.editedFilesSet.add(fname);
                                allChangedFiles.add(fname);
                                addDynamicallyRelevantFile(fname);
                                await updateFileEntry(fname, context.fileMap, undefined, {
                                    filename: fname, description: existed ? `[Binary File modified by ${toolName}]` : `[Binary File created by ${toolName}]`, relatedFiles: ''
                                });
                            } else {
                                const decodedText = Buffer.from(file.content, 'base64').toString('utf8');
                                if (Buffer.byteLength(decodedText, 'utf8') > (LARGE_FILE_LIMIT_KB * 1024)) {
                                    context.binaryFileMap.set(fname, file.content);
                                    context.fileMap.delete(fname); 
                                    context.editedFilesSet.add(fname);
                                    allChangedFiles.add(fname);
                                    addDynamicallyRelevantFile(fname);
                                    await updateFileEntry(fname, context.fileMap, undefined, {
                                        filename: fname, description: existed ? `[Modified by ${toolName} (Large Text)]` : `[Created by ${toolName} (Large Text)]`, relatedFiles: '' 
                                    });
                                }
                            }
                        }
                    }
                    
                    if (allChangedFiles.size > 0 && context.transcriptsToUpdate) {
                        allChangedFiles.forEach(filename => {
                            context.transcriptsToUpdate?.forEach(transcript => {
                                transcript.supersedeEntry(filename);
                            });
                        });
                    }

                    diffApplicationLog = `Successfully applied changes to: ${Array.from(allChangedFiles).join(', ')}`;
                } else {
                    updateProgress(`Failed to apply the reviewed diff: ${applyResult.error}`);
                    diffApplicationLog = `Failed to apply diff: ${applyResult.error}`;
                }
            } else {
                diffApplicationLog = "No changes were applied based on the review decision.";
            }

            const decision = verifJson.decision || "UNKNOWN";
            const reasoning = verifJson.reasoning || "No reasoning provided.";
            diffApplicationLog = `**Review Decision:** ${decision}\n**Reasoning:** ${reasoning}\n\n${diffApplicationLog}`;
        }
    }
    return diffApplicationLog;
}