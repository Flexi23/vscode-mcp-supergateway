"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class VaultService {
    vaultRoot;
    constructor(vaultPath) {
        this.vaultRoot = vaultPath ? path_1.default.resolve(vaultPath) : path_1.default.resolve(process.cwd(), 'vault');
    }
    getVaultPath(relativePath) {
        return path_1.default.resolve(this.vaultRoot, relativePath);
    }
    async readNote(relativePath) {
        const fullPath = this.getVaultPath(relativePath);
        return fs_1.default.readFileSync(fullPath, 'utf8');
    }
    async writeNote(relativePath, content) {
        const fullPath = this.getVaultPath(relativePath);
        fs_1.default.writeFileSync(fullPath, content, 'utf8');
    }
    async listNotes() {
        const files = fs_1.default.readdirSync(this.vaultRoot);
        return files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    }
    async readContract() {
        const fullPath = this.getVaultPath('meta/contract.md');
        return fs_1.default.readFileSync(fullPath, 'utf8');
    }
}
exports.VaultService = VaultService;
