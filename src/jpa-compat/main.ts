import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { JpaCompatModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(JpaCompatModule);
  await app.listen(3000);
  console.log('jpa-compat server running on http://localhost:3000');
}

bootstrap();
