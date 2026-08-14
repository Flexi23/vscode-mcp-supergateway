import { lmstudioClient } from './lmstudio';
import { VaultManager } from './vaultManager';

export class LoopbackWorkflow {
  private readonly vaultManager: VaultManager;

  constructor(vaultManager: VaultManager) {
    this.vaultManager = vaultManager;
  }

  async executeTask(taskPath: string): Promise<string> {
    try {
      // 1. Read the task content from the vault
      const content = await this.vaultManager.readNote(taskPath);
      
      // 2. Send it to the LLM to execute
      // We use a specific system prompt for task execution
      const systemPrompt = `You are a task execution agent. You have access to tools to interact with the vault and other local resources.
    Your goal is to complete the following task. 
    After completion, update the vault task using 'lmstudio_update_vault_task' to mark it as done.
    
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
