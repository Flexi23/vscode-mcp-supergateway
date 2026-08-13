import fs from 'fs';
import path from 'path';

export class VaultService {
  private readonly vaultRoot: string;

  constructor(vaultPath?: string) {
    this.vaultRoot = vaultPath ? path.resolve(vaultPath) : path.resolve(process.cwd(), 'vault');
  }

  private getVaultPath(relativePath: string) {
    return path.resolve(this.vaultRoot, relativePath);
  }

  async readNote(relativePath: string) {
    const fullPath = this.getVaultPath(relativePath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  async writeNote(relativePath: string, content: string) {
    const fullPath = this.getVaultPath(relativePath);
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  async listNotes() {
    const files = fs.readdirSync(this.vaultRoot);
    return files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
  }

  async readContract() {
    const fullPath = this.getVaultPath('meta/contract.md');
    return fs.readFileSync(fullPath, 'utf8');
  }
}
