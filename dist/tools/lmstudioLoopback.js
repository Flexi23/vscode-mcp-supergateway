"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLMStudioTools = void 0;
const lmstudio_1 = require("../services/lmstudio");
const zod_1 = require("zod");
const child_process_1 = require("child_process");
const registerLMStudioTools = (registerTool, vaultService) => {
    // 1. lmstudio_complete
    const lmstudioCompleteSchema = zod_1.z.object({
        prompt: zod_1.z.string().min(1),
        system_prompt: zod_1.z.string().optional(),
        temperature: zod_1.z.number().min(0).max(1).optional(),
        max_tokens: zod_1.z.number().min(1).optional(),
    });
    registerTool({
        name: 'lmstudio_complete',
        description: 'Execute direct raw completions on the active local model.',
        inputSchema: lmstudioCompleteSchema.shape,
        execute: async (args) => {
            try {
                const validatedArgs = lmstudioCompleteSchema.parse(args);
                const result = await lmstudio_1.lmstudioClient.generateCompletion(validatedArgs.prompt, validatedArgs.system_prompt, {
                    temperature: validatedArgs.temperature ?? 0.2,
                    max_tokens: validatedArgs.max_tokens ?? 2048,
                });
                return { content: result };
            }
            catch (e) {
                return { content: `Error executing lmstudio_complete: ${e.message}` };
            }
        },
    });
    // 2. lmstudio_summarize_diff
    const lmstudioSummarizeDiffSchema = zod_1.z.object({
        diff: zod_1.z.string().optional(),
    });
    registerTool({
        name: 'lmstudio_summarize_diff',
        description: 'Parse Git diffs and generate concise change summaries or ADR drafts.',
        inputSchema: lmstudioSummarizeDiffSchema.shape,
        execute: async (args) => {
            try {
                const validatedArgs = lmstudioSummarizeDiffSchema.parse(args);
                let diffContent = validatedArgs.diff;
                if (!diffContent) {
                    try {
                        diffContent = (0, child_process_1.execSync)('git diff').toString();
                    }
                    catch (e) {
                        return { content: 'Error: Could not get git diff. Ensure you are in a git repository with changes.' };
                    }
                }
                const result = await lmstudio_1.lmstudioClient.generateCompletion(`Summarize the following git diff concisely. If it looks like a significant architectural change, suggest an ADR draft:\n\n${diffContent}`);
                return { content: result };
            }
            catch (e) {
                return { content: `Error executing lmstudio_summarize_diff: ${e.message}` };
            }
        },
    });
    // 3. lmstudio_update_vault_task
    const lmstudioUpdateVaultTaskSchema = zod_1.z.object({
        task_path: zod_1.z.string().min(1),
        content: zod_1.z.string().min(1),
    });
    registerTool({
        name: 'lmstudio_update_vault_task',
        description: 'Update YAML frontmatter and task markdown files within the vault.',
        inputSchema: lmstudioUpdateVaultTaskSchema.shape,
        execute: async (args) => {
            try {
                const validatedArgs = lmstudioUpdateVaultTaskSchema.parse(args);
                vaultService.writeNote(validatedArgs.task_path, validatedArgs.content);
                return { content: `Successfully updated ${validatedArgs.task_path}` };
            }
            catch (e) {
                return { content: `Error updating vault task: ${e.message}` };
            }
        },
    });
};
exports.registerLMStudioTools = registerLMStudioTools;
