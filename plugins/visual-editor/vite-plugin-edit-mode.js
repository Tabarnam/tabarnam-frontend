import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { EDIT_MODE_STYLES } from './visual-editor-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

export default function inlineEditDevPlugin() {
  return {
    name: 'vite:inline-edit-dev',
    apply: 'serve',
    
    // ✅ Dev log for clarity
    configResolved(config) {
      console.log('[vite:inline-edit-dev] Edit mode plugin injected at root:', config.root);
    },

    transformIndexHtml() {
      const scriptPath = resolve(__dirname, 'edit-mode-script.js');
      const scriptContent = readFileSync(scriptPath, 'utf-8');

      return [
        {
          tag: 'script',
          attrs: {
