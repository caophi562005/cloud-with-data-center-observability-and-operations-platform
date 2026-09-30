import { describe, expect, it, vi } from 'vitest';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';
import { configureApp } from './main.js';

vi.mock('./app.module.js', () => ({ AppModule: class AppModule {} }));
vi.mock('cookie-parser', () => ({ default: vi.fn(() => 'cookie-parser') }));
vi.mock('helmet', () => ({ default: vi.fn(() => 'helmet') }));
vi.mock('@nestjs/swagger', () => ({
  DocumentBuilder: class {
    setTitle() {
      return this;
    }
    setDescription() {
      return this;
    }
    setVersion() {
      return this;
    }
    addCookieAuth() {
      return this;
    }
    build() {
      return {};
    }
  },
  SwaggerModule: {
    createDocument: vi.fn(() => ({})),
    setup: vi.fn(),
  },
}));

describe('configureApp', () => {
  it('configures the API prefix, exact-origin CORS, security middleware, shutdown hooks, and request IDs', async () => {
    const app = {
      use: vi.fn(),
      useGlobalFilters: vi.fn(),
      useGlobalInterceptors: vi.fn(),
      setGlobalPrefix: vi.fn(),
      enableCors: vi.fn(),
      enableShutdownHooks: vi.fn(),
    };

    await configureApp(app as never, {
      webUrl: 'http://localhost:5173',
      nodeEnv: 'test',
    });

    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
    expect(app.enableCors).toHaveBeenCalledWith({
      origin: 'http://localhost:5173',
      credentials: true,
    });
    expect(app.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(app.use).toHaveBeenCalledTimes(2);
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(RequestIdInterceptor),
    );
  });
});
