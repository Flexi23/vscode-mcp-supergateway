import fetch from 'node-fetch';

// Thin wrapper around the SiYuan Kernel API, replacing the file-based VaultManager
// for the LM Studio task loopback now that notes/tasks live in SiYuan.
export class SiyuanClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor() {
    this.baseUrl =
      process.env.SIYUAN_URL || `http://${process.env.SIYUAN_HOST || 'siyuan'}:${process.env.SIYUAN_PORT || '6806'}`;
    this.token = process.env.SIYUAN_TOKEN || '';
  }

  private async call<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { code: number; msg?: string; data: T };
    if (json.code !== 0) {
      throw new Error(`SiYuan API error (${endpoint}): ${json.msg || response.statusText}`);
    }
    return json.data;
  }

  // Reads a document's content (Markdown) by block/doc ID.
  async readDoc(id: string): Promise<string> {
    const data = await this.call<{ content: string }>('/api/filetree/getDoc', { id });
    return data.content;
  }

  // Replaces a block's (or document root's) content with new Markdown.
  async writeDoc(id: string, markdown: string): Promise<void> {
    await this.call('/api/block/updateBlock', { id, dataType: 'markdown', data: markdown });
  }

  async listNotebooks(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.call<{ notebooks: Array<{ id: string; name: string }> }>('/api/notebook/lsNotebooks');
    return data.notebooks;
  }
}

export const siyuanClient = new SiyuanClient();
