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

import { MultiAgentToolContext } from '../../momoa_core/types.js';
import { 
    ExecutionProvider, 
    ExecutionRequest, 
    ExecutionResponse, 
    FilePayload
} from '../executionProvider.js';

export class JulesExecutionProvider implements ExecutionProvider {
    RESULT_JSON_FILENAME = 'jules_execution_result.json'
    
    providerName = "Jules";
    isPersistentSandbox = false;
    
    // Target uptime per Jules session to optimize cost (e.g., 5 mins)
    private targetSessionUptimeMs: number = 5 * 60 * 1000;

    constructor(
        private context: MultiAgentToolContext,
        private executeToolFn: (toolName: string, params: any, context: MultiAgentToolContext) => Promise<any>
    ) { }

    async stageFiles(_files: FilePayload[], _targetDir: string): Promise<void> {
        
    }

    async cleanupSandbox(): Promise<void> {
        // Not required. VM is ephemeral. 
    }
    
    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        const envsToRun = request.envs && request.envs.length > 0 ? request.envs : [{}];
        const totalTasks = envsToRun.length;

        if (totalTasks === 0) {
            throw new Error("No tasks provided for execution.");
        }

        // 1. Stage dynamic files into the context so Jules natively syncs them
        if (request.files)
            for (const file of request.files) {
                if (!this.context.fileMap.has(file.path) && !this.context.binaryFileMap.has(file.path)) {
                    if (!file.isBinary) {
                        const decodedText = Buffer.from(file.content, 'base64').toString('utf8');
                        this.context.fileMap.set(file.path, decodedText);
                        this.context.editedFilesSet.add(file.path);
                    } else {
                        this.context.binaryFileMap.set(file.path, file.content);
                    }
                }
            }

        let cmdString = request.command;
        if (request.args)
            cmdString = request.command === 'sh' && request.args[0] === '-c' 
                ? request.args[1] 
                : `${request.command} ${request.args.join(' ')}`;

        // =========================================================
        // PATH A: SINGLE TASK OR DRY RUN
        // =========================================================
        if (totalTasks === 1) {
            return await this.runSingleTask(cmdString, envsToRun[0], request);
        }

        // =========================================================
        // PATH B: BATCH EXECUTION (Optimizer)
        // =========================================================
        
        // 2. Dynamic Concurrency Calculation
        // Retrieve hardware limits cached from the dry run, or use safe defaults
        const maxCpuConcurrency = (this.context as any).julesCpus || 4; 
        const vmTotalAvailableMemoryMb = (this.context as any).julesMemMb || 4096;
        
        const estimatedTaskDurationMs = request.estimatedTaskDurationMs || 60000;
        const taskMemoryMb = request.estimatedTaskPeakMemory || 500;

        const maxMemoryConcurrency = Math.max(1, Math.floor(vmTotalAvailableMemoryMb / taskMemoryMb));
        const internalConcurrency = Math.min(maxCpuConcurrency, maxMemoryConcurrency);

        console.log(`[Jules Batch] Hardware cached: ${maxCpuConcurrency} vCPUs, ${vmTotalAvailableMemoryMb}MB RAM.`);
        console.log(`[Jules Batch] Task demands ~${taskMemoryMb}MB. Internal concurrency set to: ${internalConcurrency}`);

        // 3. Horizontal Chunking
        const tasksPerSession = Math.max(
            1, 
            Math.ceil((this.targetSessionUptimeMs / estimatedTaskDurationMs) * internalConcurrency)
        );

        const sessionChunks: NodeJS.ProcessEnv[][] = [];
        // Note: Start at 0 so we batch ALL tasks together
        for (let i = 0; i < totalTasks; i += tasksPerSession) {
            sessionChunks.push(envsToRun.slice(i, i + tasksPerSession));
        }

        console.log(`[Jules Batch] Spawning ${sessionChunks.length} Jules sessions. (Max ${tasksPerSession} tasks/session)`);

        let allSucceeded = true;
        let lastError = '';
        let processedCount = 0;

        // 4. Process Chunks via Jules
        const chunkPromises = sessionChunks.map(async (chunkEnvs) => {
            // Await the actual Jules tool call
            const batchResults = await this.runBatchInJules(cmdString, chunkEnvs, internalConcurrency, request.estimatedTaskPeakMemory ?? 500, request.estimatedTaskDurationMs || 60);
            
            // Map the results array back to their respective envs and trigger callbacks
            batchResults.forEach((taskRes, index) => {
                console.log("Processing Batch Entry");
                if (taskRes.exitCode !== 0) {
                    allSucceeded = false;
                    lastError = taskRes.stderr || taskRes.error || 'Unknown error';
                }

                if (taskRes.index)
                    (taskRes as any).config = chunkEnvs[taskRes.index];
                else
                    (taskRes as any).config = chunkEnvs[index];

                if (request.onTaskComplete) {
                    console.log(`Sending Batch Entry to Optimizer: ${JSON.stringify(taskRes)}`);
                    request.onTaskComplete(taskRes);
                }
                processedCount++;
            });
        });

        await Promise.all(chunkPromises);

        return {
            stdout: `Successfully processed ${processedCount} tasks via Jules.`,
            stderr: allSucceeded ? '' : `One or more tasks failed. Last error: ${lastError}`,
            exitCode: allSucceeded ? 0 : 1,
            timedOut: false,
            generatedFiles: [] 
        };
    }

    private async runSingleTask(cmdString: string, env: NodeJS.ProcessEnv, request: ExecutionRequest): Promise<ExecutionResponse> {
        const envString = Object.entries(env)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ');
        
        const envPrefix = envString ? `export ${envString} && ` : '';

        const outputInstructions = `
CRITICAL INSTRUCTION: You must run a hardware probe AND the requested task. End the session and provide the diff / pull request immediately when the \`${this.RESULT_JSON_FILENAME}\` file has been created (after the task has been run), without waiting for further feedback.
Perform the steps in this order:
1. Run this to probe hardware: echo "$(nproc) | $(awk '/MemTotal/ {print $2}' /proc/meminfo)"
2. Run the Task Command below.
3. Create a new \`${this.RESULT_JSON_FILENAME}\` file containing the JSON block described below, based on the task execution results.
4. Return the \`${this.RESULT_JSON_FILENAME}\` file and any files generated by the task to the user as part of the diff / pull request.

Your \`json\` response MUST match this schema:
\`\`\`json
{
  "hardware": { "cpus": 2, "memMb": 1024 },
  "task": {
    "stdout": "...",    // Stdout received from running the task.
    "stderr": "...",    // Stderr received from running the task.
    "exitCode": 0,      // Exit code from the task.
    "durationMs": 1200, // Task execution durations in milliseconds.
    "peakMemoryMb": 512 // Peak memory required by the task.
  }
}
\`\`\`

`.trim();

        const testParams = {
            forceAcceptFile: this.RESULT_JSON_FILENAME, 
            request: `${outputInstructions}

Task Command:
${envPrefix}${cmdString}`
        };

        const response: ExecutionResponse = {
            stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: []
        };

        try {
            const testResult = await this.executeToolFn('JULES{', testParams, this.context);
            
            const resultFileName = this.RESULT_JSON_FILENAME;
            const jsonFileContent = this.context.fileMap.get(resultFileName);

            if (jsonFileContent) {
                const parsed = JSON.parse(jsonFileContent);
                
                // Remove the JSON file from the project files
                this.context.fileMap.delete(resultFileName);
                this.context.editedFilesSet.delete(resultFileName);
                
                // Cache hardware specs for the upcoming batch run
                if (parsed.hardware) {
                    (this.context as any).julesCpus = parseInt(parsed.hardware.cpus, 10) || 4;
                    // Keep a 500MB safety buffer
                    (this.context as any).julesMemMb = Math.max(500, parseInt(parsed.hardware.memMb, 10) - 500); 
                }

                if (parsed.task) {
                    response.stdout = parsed.task.stdout || '';
                    response.stderr = parsed.task.stderr || '';
                    response.exitCode = parsed.task.exitCode !== undefined ? parsed.task.exitCode : 0;
                    response.durationMs = parsed.task.durationMs;
                    response.peakMemory = parsed.task.peakMemoryMb;
                }
            } else {
                // If we send the Jules result, clean it up.
                let cleanJulesResponse:string = testResult.result;
                cleanJulesResponse = cleanJulesResponse.trim().slice(1,-1);
                cleanJulesResponse = cleanJulesResponse.split("**Jules Log Summary:**")[0].trim();
                response.stdout = `Jules completed successfully, but did not produce the required execution log.\n${cleanJulesResponse}`;
            }
        } catch (e: any) {
            response.error = e.message;
            if (e.name === 'TimeoutError' || e.message?.toLowerCase().includes('timeout')) {
                response.timedOut = true;
                response.stderr = `Dry run timed out after ${request.timeoutMs}ms`;
            }
        }

        // Trigger completion callback
        (response as any).env = env;
        if (request.onTaskComplete) {
            request.onTaskComplete(response);
        }

        return response;
    }

    private async runBatchInJules(cmdString: string, chunkEnvs: NodeJS.ProcessEnv[], concurrency: number, estimatedMemoryMb: number, estimatedTaskDuration: number): Promise<ExecutionResponse[]> {
        let taskListText = '';
        chunkEnvs.forEach((env, index) => {
            const envString = Object.entries(env)
                .filter(([_, v]) => v !== undefined)
                .map(([k, v]) => `${k}="${v}"`)
                .join(' ');
            
            taskListText += `Task Index: ${index}
Env: ${envString}
Command: ${cmdString}

`;
        });

        const prompt = `CRITICAL INSTRUCTION: You are acting as a batch execution engine, executing the ${chunkEnvs.length} provided tasks in the Task List. End the session and provide the diff / pull request immediately when the \`${this.RESULT_JSON_FILENAME}\` file has been created (after all the tasks have been run and completed), without waiting for further feedback.

You have ${concurrency} CPUs available for running concurrent workers, and each task requires an estimated ${estimatedMemoryMb} Mb of memory and approximately ${estimatedTaskDuration} seconds to complete. Please run these tasks as efficiently as possible, managing them in parallel if your environment supports it.

Perform the steps in this order:
1. Run the complete list of tasks provided in the Task List below.
2. Create a new \`${this.RESULT_JSON_FILENAME}\` file containing the JSON block described below, based on the task execution results.
3. Return the \`${this.RESULT_JSON_FILENAME}\` file to the user as part of the diff / pull request.

**Task List:**
${taskListText}

**Your \`json\` response MUST match this schema, where each object represents a task in the task list:**
\`\`\`json
[
  {
    "index": 0,         // Task Index of the task being exectuted.
    "stdout": "...",    // Stdout received from running the task.
    "stderr": "...",    // Stderr received from running the task.
    "exitCode": 0,      // Exit code from the task.
    "durationMs": 1200, // Task execution durations in milliseconds.
    "peakMemoryMb": 512 // Peak memory required by the task.
  }
]
\`\`\`
`.trim();

        try {
            const testResult = await this.executeToolFn('JULES{', { request: prompt, forceAcceptFile: this.RESULT_JSON_FILENAME }, this.context);
            
            // const jsonMatch = testResult.result.match(/```json\s*([\s\S]*?)\s*```/) || testResult.result.match(/\[[\s\S]*\]/);

            const resultFileName = this.RESULT_JSON_FILENAME;
            const jsonFileContent = this.context.fileMap.get(resultFileName);

            if (jsonFileContent) {
                console.log("JSON output file found");
                const parsed = JSON.parse(jsonFileContent);
                
                // Remove the JSON file from the project files
                this.context.fileMap.delete(resultFileName);
                this.context.editedFilesSet.delete(resultFileName);    
                // const parsedArray = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                if (Array.isArray(parsed)) {
                    console.log("JSON array parsed");
                    // Map the raw JSON back to full ExecutionResponse objects
                    return parsed.map(item => ({
                        index: item.index || undefined,
                        stdout: item.stdout || '',
                        stderr: item.stderr || '',
                        exitCode: item.exitCode !== undefined ? item.exitCode : 1,
                        durationMs: item.durationMs,
                        peakMemory: item.peakMemoryMb,
                        timedOut: false,
                        generatedFiles: []
                    }));
                }
            }
            throw new Error(`Failed to parse batch array payload: ${testResult.result}`);

        } catch (e: any) {
            return chunkEnvs.map(() => ({
                stdout: '',
                stderr: `Batch execution failed: ${e.message}`,
                exitCode: 1,
                timedOut: e.name === 'TimeoutError' || e.message?.toLowerCase().includes('timeout'),
                error: e.message,
                generatedFiles: []
            }));
        }
    }
}