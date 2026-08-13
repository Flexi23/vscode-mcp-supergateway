"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lmstudioClient = exports.LMStudioClient = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
class LMStudioClient {
    baseUrl = 'http://localhost:1234/v1';
    async isServerAvailable() {
        try {
            const response = await (0, node_fetch_1.default)(`${this.baseUrl}/ping`, { method: 'GET' });
            return response.ok;
        }
        catch (error) {
            return false;
        }
    }
    async getActiveModel() {
        try {
            const response = await (0, node_fetch_1.default)(`${this.baseUrl}/models`, { method: 'GET' });
            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.statusText}`);
            }
            const data = (await response.json());
            const models = data.data || [];
            if (models.length > 0) {
                return models[0].id;
            }
            throw new Error('No models found');
        }
        catch (error) {
            console.error('Error fetching models:', error);
            throw error;
        }
    }
    async generateCompletion(prompt, systemPrompt, options = {}) {
        const { temperature = 0.2, max_tokens = 2048, timeout = 30000, system_prompt = '' } = options;
        const truncatedPrompt = this.truncatePrompt(prompt);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await (0, node_fetch_1.default)(`${this.baseUrl}/chat/completions`, {
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
            const data = (await response.json());
            return data.choices[0].message.content;
        }
        catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('LM Studio request timed out.');
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    truncatePrompt(prompt) {
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
exports.LMStudioClient = LMStudioClient;
exports.lmstudioClient = new LMStudioClient();
