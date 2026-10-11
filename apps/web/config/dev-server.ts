import { readFileSync } from 'node:fs'
import type { ServerOptions } from 'vite'

export type DevHttpsMaterials = { key: Buffer; cert: Buffer }

export function buildDevServerOptions(input: {
  apiTarget?: string; https?: DevHttpsMaterials;
}): ServerOptions {
  let target = 'http://localhost:3000'
  if (input.apiTarget !== undefined) {
    try {
      const url = new URL(input.apiTarget)
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
          !/^https:\/\/[^/@?#\\\s]+\/?$/i.test(input.apiTarget)) {
        throw new Error()
      }
      target = input.apiTarget
    } catch {
      throw new Error('Invalid API proxy target: expected an HTTPS origin')
    }
  }
  return {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    ...(input.https ? { https: input.https } : {}),
    proxy: { '/api': { target, changeOrigin: true, secure: true } },
  }
}

export function loadDevServerOptions(env: NodeJS.ProcessEnv): ServerOptions {
  const certPath = env.OPSGRID_DEV_HTTPS_CERT
  const keyPath = env.OPSGRID_DEV_HTTPS_KEY
  if ((certPath !== undefined) !== (keyPath !== undefined)) {
    throw new Error('HTTPS certificate and key must be configured together')
  }
  let https: DevHttpsMaterials | undefined
  if (certPath !== undefined && keyPath !== undefined) {
    try {
      const cert = readFileSync(certPath)
      const key = readFileSync(keyPath)
      if (!cert.length || !key.length) throw new Error()
      https = { cert, key }
    } catch {
      // Never propagate filesystem diagnostics, paths, or certificate/key contents.
      throw new Error('Unable to load HTTPS certificate and key')
    }
  }
  return buildDevServerOptions({ apiTarget: env.OPSGRID_API_PROXY_TARGET, https })
}
