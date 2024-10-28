import { NestFactory, PartialGraphHost } from '@nestjs/core';
import { AppModule } from './app.module';
import * as fs from 'fs';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
  });
  
  await app.listen(3000);
}
bootstrap().catch((err) => {
  console.error("Bootstrap process failed:", err);
  fs.writeFileSync("graph.json", PartialGraphHost.toString() ?? "");
  process.exit(1);
});
