import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';

export type BootstrapConfig = {
  webUrl: string;
  nodeEnv: string;
};

export async function configureApp(
  app: INestApplication,
  configuration: BootstrapConfig,
): Promise<void> {
  app.use(cookieParser());
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: configuration.webUrl,
    credentials: true,
  });
  app.enableShutdownHooks();
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CloudOps API')
    .setDescription('CloudOps identity and operations API')
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);
}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const nodeEnv = config.getOrThrow<string>('app.nodeEnv');

  if (nodeEnv === 'production') {
    app.useLogger(app.get(PinoLogger));
  } else {
    app.flushLogs();
  }

  await configureApp(app, {
    webUrl: config.getOrThrow<string>('app.webUrl'),
    nodeEnv,
  });
  await app.listen(config.getOrThrow<number>('app.port'));
}

if (isMainModule()) {
  void bootstrap();
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  const entrypointUrl = pathToFileURL(entrypoint).href;
  return (
    entrypointUrl === import.meta.url ||
    pathToFileURL(`${entrypoint}.js`).href === import.meta.url
  );
}
