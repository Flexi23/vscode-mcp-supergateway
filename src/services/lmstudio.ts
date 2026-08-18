import fetch from 'node-fetch';

export interface ModelConfig {
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  system_prompt?: string;
}

import { requireEnv } from '../config/env';

export class LMStudioClient {
  // overridable so the backend can reach a host-side LM Studio instance when containerized
  private readonly baseUrl: string = requireEnv('LMSTUDIO_BASE_URL');

  async isServerAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/ping`, { method: 'GET' });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async getActiveModel(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }
      const data = (await response.json()) as any;
      const models = data.data || [];
      if (models.length > 0) {
        return models[0].id;
      }
      throw new Error('No models found');
    } catch (error) {
      console.error('Error fetching models:', error);
      throw error;
    }
  }

  async generateCompletion(
    prompt: string,
    systemPrompt?: string,
    options: ModelConfig = {}
  ): Promise<string> {
    const {
      temperature = 0.2,
      max_tokens = 2048,
      timeout = 30000,
      system_prompt = ''
    } = options;

    const truncatedPrompt = this.truncatePrompt(prompt);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'local-model',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: truncatedPrompt }
          ],
          temperature,
          max_tokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LM Studio API error: ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      return data.choices[0].message.content;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error('LM Studio request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private truncatePrompt(prompt: string): string {
    const MAX_TOKENS = 8000;
    // Simple heuristic: 1 token approx 4 characters.
    // We want to stay well under 8000 tokens.
    const MAX_CHARS = MAX_TOKENS * 3; 
    if (prompt.length <= MAX_CHARS) {
      return prompt;
    }
    return prompt.substring(0, MAX_CHARS) + '... [Truncated]';
  }
}

export const lmstudioClient = new LMStudioClient();
