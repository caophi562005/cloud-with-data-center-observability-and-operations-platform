import { defineConfig, loadEnv } from 'vite'
import { resolveApiOrigin } from './config/api-origin.ts'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadDevServerOptions } from './config/dev-server.ts'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  resolveApiOrigin(env.VITE_API_URL, command === 'build')

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: loadDevServerOptions(process.env),
  }
})