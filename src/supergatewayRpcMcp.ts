import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { lmstudioClient } from './services/lmstudio';
import { siyuanClient } from './services/siyuanClient';

const lmstudioCompleteSchema = z.object({
  prompt: z.string().min(1),
  system_prompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  max_tokens: z.number().min(1).optional(),
});

const lmstudioSummarizeDiffSchema = z.object({
  diff: z.string().optional(),
});

const lmstudioUpdateSiyuanTaskSchema = z.object({
  doc_id: z.string().min(1),
  content: z.string().min(1),
});

const server = new McpServer(
  {
    name: 'supergateway-rpc',
    version: '0.1.0',
  },
  {
    capabilities: {},
  },
);

server.registerTool('lmstudio_complete', {
  description: 'Execute direct raw completions on the active local model.',
  inputSchema: lmstudioCompleteSchema.shape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  try {
    const validatedArgs = lmstudioCompleteSchema.parse(args ?? {});
    const result = await lmstudioClient.generateCompletion(
      validatedArgs.prompt,
      validatedArgs.system_prompt,
      {
        temperature: validatedArgs.temperature ?? 0.2,
        max_tokens: validatedArgs.max_tokens ?? 2048,
      },
    );

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text' as const, text: `Error executing lmstudio_complete: ${error.message}` }],
    };
  }
});

server.registerTool('lmstudio_summarize_diff', {
  description: 'Parse Git diffs and generate concise change summaries or ADR drafts.',
  inputSchema: lmstudioSummarizeDiffSchema.shape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  try {
    const validatedArgs = lmstudioSummarizeDiffSchema.parse(args ?? {});

    let diffContent = validatedArgs.diff;
    if (!diffContent) {
      try {
        diffContent = execSync('git diff').toString();
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: Could not get git diff. Ensure you are in a git repository with changes.' }],
        };
      }
    }

    const result = await lmstudioClient.generateCompletion(
      `Summarize the following git diff concisely. If it looks like a significant architectural change, suggest an ADR draft:\n\n${diffContent}`,
    );

    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text' as const, text: `Error executing lmstudio_summarize_diff: ${error.message}` }],
    };
  }
});

server.registerTool('lmstudio_update_siyuan_task', {
  description: 'Update a task document in SiYuan Note with new Markdown content.',
  inputSchema: lmstudioUpdateSiyuanTaskSchema.shape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  try {
    const validatedArgs = lmstudioUpdateSiyuanTaskSchema.parse(args ?? {});
    await siyuanClient.writeDoc(validatedArgs.doc_id, validatedArgs.content);

    return {
      content: [{ type: 'text' as const, text: `Successfully updated ${validatedArgs.doc_id}` }],
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text' as const, text: `Error updating SiYuan task: ${error.message}` }],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[supergateway-rpc] ready');
}

main().catch((error) => {
  console.error('[supergateway-rpc] failed to start:', error);
  process.exit(1);
});
