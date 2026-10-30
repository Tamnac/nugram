import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import devtools from 'solid-devtools/vite'
import { readFileSync } from 'fs'

const faviconPlugin = () => ({
  name: 'serve-favicon',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/favicon.ico') {
        res.setHeader('Content-Type', 'image/x-icon')
        res.end(readFileSync('src/assets/favicon.ico'))
      } else next()
    })
  }
})

export default defineConfig({
  define: {
    __PROJECT_DIR__: JSON.stringify(process.cwd().replace(/\\/g, '/')),
  },
  plugins: [faviconPlugin(), devtools({targetIDE: 'vscode', autoname: true}), solidPlugin()],
  server: {
    port: 3000,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/anth-local': {
        target: 'http://127.0.0.1:8084',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anth-local/, ''),
        secure: false
      }
    }
  },
  build: {
    target: 'esnext',
  },
});
