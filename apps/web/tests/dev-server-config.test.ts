// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ProxyOptions } from 'vite'
import { buildDevServerOptions, loadDevServerOptions } from '../config/dev-server'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const proxy = (input: Parameters<typeof buildDevServerOptions>[0]): ProxyOptions =>
  buildDevServerOptions(input).proxy!['/api'] as ProxyOptions

describe('dev server configuration', () => {
  it('keeps_local_default', () => {
    expect(buildDevServerOptions({})).toMatchObject({ host: '127.0.0.1', port: 5173, strictPort: true })
    expect(proxy({}).target).toBe('http://localhost:3000')
    expect(buildDevServerOptions({}).https).toBeUndefined()
  })
  it('uses_remote_https_without_path_rewrite', () => {
    expect(proxy({ apiTarget: 'https://api.opsgrid.hacmieu.com' })).toMatchObject({
      target: 'https://api.opsgrid.hacmieu.com', changeOrigin: true, secure: true,
    })
    expect(proxy({ apiTarget: 'https://api.opsgrid.hacmieu.com' }).rewrite).toBeUndefined()
  })
  it('does_not_override_browser_origin_or_cookies', () => {
    const options = proxy({ apiTarget: 'https://api.opsgrid.hacmieu.com' })
    expect(options.headers).toBeUndefined()
    expect(options.cookieDomainRewrite).toBeUndefined()
    expect(options.cookiePathRewrite).toBeUndefined()
    expect(options.configure).toBeUndefined()
  })
  it.each([
    'http://api.opsgrid.hacmieu.com', 'http://127.0.0.1:3000',
    'https://name:password@api.example.com', 'https://api.example.com?key=value',
    'https://api.example.com#fragment', 'https://api.example.com/api', 'not-a-url',
    'https://api.example.com/?', 'https://api.example.com/#',
  ])('rejects_remote_http_userinfo_query_fragment_or_base_path: %s', (apiTarget) => {
    expect(() => buildDevServerOptions({ apiTarget })).toThrow(/proxy target/i)
  })
  it('requires_certificate_and_key_together', () => {
    for (const env of [{ OPSGRID_DEV_HTTPS_CERT: 'leaf.pem' }, { OPSGRID_DEV_HTTPS_KEY: 'key.pem' }]) {
      expect(() => loadDevServerOptions(env)).toThrow(/certificate and key/i)
    }
  })
  it('loads_materials_only_on_server', () => {
    const cert = Buffer.from('test certificate')
    const key = Buffer.from('test key')
    vi.mocked(readFileSync).mockImplementation((path) => path === 'leaf.pem' ? cert : key)
    const options = loadDevServerOptions({
      OPSGRID_API_PROXY_TARGET: 'https://api.example.com',
      OPSGRID_DEV_HTTPS_CERT: 'leaf.pem', OPSGRID_DEV_HTTPS_KEY: 'key.pem',
      PASSWORD: 'never-forward-this', AWS_SECRET_ACCESS_KEY: 'never-forward-this',
    })
    expect(options.https).toEqual({ cert, key })
    expect(options.proxy!['/api']).toMatchObject({ target: 'https://api.example.com', secure: true })
    expect(JSON.stringify(options)).not.toContain('never-forward-this')
  })
  it('rejects_invalid_or_unreadable_certificate_paths_without_echoing_contents', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('secret contents and private path') })
    const call = () => loadDevServerOptions({ OPSGRID_DEV_HTTPS_CERT: 'private.pem', OPSGRID_DEV_HTTPS_KEY: 'private-key.pem' })
    expect(call).toThrow(/unable to load/i)
    try { call() } catch (error) {
      expect(String(error)).not.toContain('secret contents')
      expect(String(error)).not.toContain('private.pem')
    }
  })
  it('rejects_empty_materials', () => {
    vi.mocked(readFileSync).mockReturnValue(Buffer.alloc(0))
    expect(() => loadDevServerOptions({ OPSGRID_DEV_HTTPS_CERT: 'leaf.pem', OPSGRID_DEV_HTTPS_KEY: 'key.pem' })).toThrow(/unable to load/i)
  })
})
