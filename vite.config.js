import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const configHorizonsViteErrorHandler = `
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (
          addedNode.nodeType === Node.ELEMENT_NODE &&
          (addedNode.tagName?.toLowerCase() === 'vite-error-overlay' || 
           addedNode.classList?.contains('backdrop'))
        ) {
          handleViteOverlay(addedNode);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
`;

export default async function () {
  const isDev = process.env.NODE_ENV !== 'production';

  let inlineEditPlugin, editModeDevPlugin;

  if (isDev) {
    inlineEditPlugin = (await import('./plugins/visual-editor/vite-plugin-react-inline-editor.js')).default;
    editModeDevPlugin = (await import('./plugins/visual-editor/vite-plugin-edit-mode.js')).default;
    console.log('[Vite Config] Visual editor plugins enabled in dev mode');
  }

  return defineConfig({
    plugins: [
      react(),
      ...(isDev ? [inlineEditPlugin, editModeDevPlugin] : [])
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@pages': path.resolve(__dirname, 'pages'),
        '@components': path.resolve(__dirname, 'src/components'),
        '@contexts': path.resolve(__dirname, 'src/contexts'),
      },
    },
    define: {
      __HORIZONS_VITE_ERROR_HANDLER__: JSON.stringify(configHorizonsViteErrorHandler),
    }
  });
}
