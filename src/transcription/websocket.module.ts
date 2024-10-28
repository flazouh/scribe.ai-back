import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';

@Module({
  imports: [ConfigModule],
  providers: [TranscriptionGateway, TranscriptionService],
})
export class WebSocketModule {}
