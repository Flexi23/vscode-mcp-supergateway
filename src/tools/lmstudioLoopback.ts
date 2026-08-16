import { lmstudioClient } from '../services/lmstudio';
import { z } from 'zod';
import { execSync } from 'child_process';
import { SiyuanClient } from '../services/siyuanClient';

export const registerLMStudioTools = (registerTool: (tool: any) => void, siyuanClient: SiyuanClient) => {
  
  // 1. lmstudio_complete
  const lmstudioCompleteSchema = z.object({
    prompt: z.string().min(1),
    system_prompt: z.string().optional(),
    temperature: z.number().min(0).max(1).optional(),
    max_tokens: z.number().min(1).optional(),
  });

  registerTool({
    name: 'lmstudio_complete',
    description: 'Execute direct raw completions on the active local model.',
    inputSchema: lmstudioCompleteSchema.shape,
    execute: async (args: any) => {
      try {
        const validatedArgs = lmstudioCompleteSchema.parse(args);
        const result = await lmstudioClient.generateCompletion(
          validatedArgs.prompt,
          validatedArgs.system_prompt,
          {
            temperature: validatedArgs.temperature ?? 0.2,
            max_tokens: validatedArgs.max_tokens ?? 2048,
          }
        );
        return { content: result };
      } catch (e: any) {
        return { content: `Error executing lmstudio_complete: ${e.message}` };
      }
    },
  });

  // 2. lmstudio_summarize_diff
  const lmstudioSummarizeDiffSchema = z.object({
    diff: z.string().optional(),
  });

  registerTool({
    name: 'lmstudio_summarize_diff',
    description: 'Parse Git diffs and generate concise change summaries or ADR drafts.',
    inputSchema: lmstudioSummarizeDiffSchema.shape,
    execute: async (args: any) => {
      try {
        const validatedArgs = lmstudioSummarizeDiffSchema.parse(args);
        let diffContent = validatedArgs.diff;
        if (!diffContent) {
          try {
            diffContent = execSync('git diff').toString();
          } catch (e) {
            return { content: 'Error: Could not get git diff. Ensure you are in a git repository with changes.' };
          }
        }
        const result = await lmstudioClient.generateCompletion(
          `Summarize the following git diff concisely. If it looks like a significant architectural change, suggest an ADR draft:\n\n${diffContent}`
        );
        return { content: result };
      } catch (e: any) {
        return { content: `Error executing lmstudio_summarize_diff: ${e.message}` };
      }
    },
  });

  // 3. lmstudio_update_siyuan_task
  const lmstudioUpdateSiyuanTaskSchema = z.object({
    doc_id: z.string().min(1),
    content: z.string().min(1),
  });

  registerTool({
    name: 'lmstudio_update_siyuan_task',
    description: 'Update a task document in SiYuan Note with new Markdown content.',
    inputSchema: lmstudioUpdateSiyuanTaskSchema.shape,
    execute: async (args: any) => {
      try {
        const validatedArgs = lmstudioUpdateSiyuanTaskSchema.parse(args);
        await siyuanClient.writeDoc(validatedArgs.doc_id, validatedArgs.content);
        return { content: `Successfully updated ${validatedArgs.doc_id}` };
      } catch (e: any) {
        return { content: `Error updating SiYuan task: ${e.message}` };
      }
    },
  });
};
