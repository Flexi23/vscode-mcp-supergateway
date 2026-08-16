import { lmstudioClient } from './lmstudio';
import { SiyuanClient } from './siyuanClient';

export class LoopbackWorkflow {
  private readonly siyuanClient: SiyuanClient;

  constructor(siyuanClient: SiyuanClient) {
    this.siyuanClient = siyuanClient;
  }

  async executeTask(docId: string): Promise<string> {
    try {
      // 1. Read the task content from SiYuan
      const content = await this.siyuanClient.readDoc(docId);

      // 2. Send it to the LLM to execute
      // We use a specific system prompt for task execution
      const systemPrompt = `You are a task execution agent. You have access to tools to interact with SiYuan Note and other local resources.
    Your goal is to complete the following task. 
    After completion, update the task using 'lmstudio_update_siyuan_task' to mark it as done.
    
    Task:
    ${content}`;

      const result = await lmstudioClient.generateCompletion(
        `Please start executing this task.`,
        systemPrompt
      );
      
      return result;
    } catch (error: any) {
      return `Error executing task: ${error.message}`;
    }
  }
}
