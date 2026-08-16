import fs from 'fs/promises';
import path from 'path';

export class VaultManager {
  private readonly vaultRoot: string;

  constructor(vaultPath?: string) {
    // Shares VAULT_PATH with the markdown-vault upstream so both see the same files.
    this.vaultRoot = path.resolve(vaultPath ?? process.env.VAULT_PATH ?? path.resolve(__dirname, '../../vault'));
  }

  private getVaultPath(relativePath: string) {
    return path.resolve(this.vaultRoot, relativePath);
  }

  async readNote(relativePath: string): Promise<string> {
    const fullPath = this.getVaultPath(relativePath);
    try {
      return await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      console.error(`Error reading note at ${relativePath}:`, err);
      throw err;
    }
  }

  async writeNote(relativePath: string, content: string): Promise<void> {
    const fullPath = this.getVaultPath(relativePath);
    try {
      await fs.writeFile(fullPath, content, 'utf8');
    } catch (err) {
      console.error(`Error writing note at ${relativePath}:`, err);
      throw err;
    }
  }

  async listNotes(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.vaultRoot);
      return files
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
    } catch (err) {
      console.error(`Error listing notes in ${this.vaultRoot}:`, err);
      return [];
    }
  }

  async readContract(): Promise<string> {
    const fullPath = this.getVaultPath('meta/contract.md');
    try {
      return await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      console.error(`Error reading contract:`, err);
      throw err;
    }
  }

  async getFrontmatter(relativePath: string): Promise<Record<string, any>> {
    const content = await this.readNote(relativePath);
    const match = content.match(/^---[\s\S]*?---\n/);
    if (!match) {
      return {};
    }
    const yaml = match[1].replace('---\n', '').replace('\n---', '');
    
    const frontmatter: Record<string, any> = {};
    const lines = yaml.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        let value: any = valueParts.join(':').trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map((v: string) => v.trim().replace(/^['"]|['"]$/g, ''));
        } else if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (value === 'null') value = null;
        else if (!isNaN(Number(value)) && value !== '') value = Number(value);
        else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        frontmatter[key.trim()] = value;
      }
    }
    return frontmatter;
  }

  async updateFrontmatter(relativePath: string, frontmatter: Record<string, any>): Promise<void> {
    const content = await this.readNote(relativePath);
    const match = content.match(/^---[\s\S]*?---\n/);
    
    let body = '';
    let oldYaml = '';
    
    if (match) {
      oldYaml = match[1].replace('---\n', '').replace('\n---', '');
      body = content.split('---\n').slice(1).join('---\n');
    } else {
      body = content;
    }

    const existingFrontmatter = this.parseYamlString(oldYaml);
    const mergedFrontmatter = { ...existingFrontmatter, ...frontmatter };

    const newYamlLines: string[] = [];
    for (const [key, value] of Object.entries(mergedFrontmatter)) {
      if (Array.isArray(value)) {
        newYamlLines.push(`${key}: [${value.map((v: any) => `"${v}"`).join(', ')}]`);
      } else if (typeof value === 'string') {
        newYamlLines.push(`${key}: "${value}"`);
      } else {
        newYamlLines.push(`${key}: ${value}`);
      }
    }

    const newYaml = newYamlLines.join('\n');
    const newContent = `---\n${newYaml}\n---\n${body}`;
    await this.writeNote(relativePath, newContent);
  }

  private parseYamlString(yaml: string): Record<string, any> {
    const frontmatter: Record<string, any> = {};
    const lines = yaml.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        let value: any = valueParts.join(':').trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map((v: string) => v.trim().replace(/^['"]|['"]$/g, ''));
        } else if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (value === 'null') value = null;
        else if (!isNaN(Number(value)) && value !== '') value = Number(value);
        else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        frontmatter[key.trim()] = value;
      }
    }
    return frontmatter;
  }
}
