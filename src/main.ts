import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { loadAiEnv } from "./config/env";

async function bootstrap(): Promise<void> {
  const env = loadAiEnv();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  app.enableShutdownHooks();

  await app.listen(env.PORT, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`ai listening on :${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error("ai failed to start", err);
  process.exit(1);
});
