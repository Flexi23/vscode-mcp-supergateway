import fetch from 'node-fetch';

export interface ModelConfig {
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  system_prompt?: string;
}

export class LMStudioClient {
  private readonly baseUrl: string = 'http://localhost:1234/v1';

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
      const data = await response.json();
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
            { role: 'user', content: prompt }
          ],
          temperature,
          max_tokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LM Studio API error: ${response.statusText}`);
      }

      const data = await response.json();
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
}

export const lmstudioClient = new LMStudioClient();
