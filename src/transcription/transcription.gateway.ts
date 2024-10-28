import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TranscriptionService } from './transcription.service';
import {
  TranscripEventCallbacks,
  TranscriptionEvents,
  TranscriptionPayload,
} from './types/transcription.types';
import { Injectable, Logger } from '@nestjs/common';
import { sendWSEvent } from './utils';


enum TranscriptionWebsocketMessages {
  REQUEST_TRANSCRIPTION = 'request_transcription',
}

enum TranscriptionWebsocketNamespaces {
  TRANSCRIPTION = 'transcription',
}
interface AuthenticatedWebSocketMessageBody<T> {
  payload: T;
}
interface TestPayload {
  message: string;
}
@Injectable()
@WebSocketGateway({
  namespace: TranscriptionWebsocketNamespaces.TRANSCRIPTION,
  cors: {
    origin: '*', // Configure according to your frontend origin
  },
  maxHttpBufferSize: 1e7
})
export class TranscriptionGateway {

  private readonly logger = new Logger(TranscriptionGateway.name);
  constructor(private readonly transcriptionService: TranscriptionService) { }

  @SubscribeMessage("test")
  async test(@ConnectedSocket() client: Socket, @MessageBody() { payload }: AuthenticatedWebSocketMessageBody<TestPayload>) {
    this.logger.log(`Received test message from client: ${client.id}: ${payload.message}`);
    client.emit("test", "test");
  }
  @SubscribeMessage("request_transcription")
  async handleTranscription(@MessageBody() { payload }: AuthenticatedWebSocketMessageBody<TranscriptionPayload>,
    @ConnectedSocket() client: Socket) {
    this.logger.log(`Received transcription request from client: ${client.id}`);
    try {
      const buffer = Buffer.from(payload.buffer);
      await this.transcriptionService.processAudio(
        { audioData: buffer, client });

    } catch (error) {
      sendWSEvent<TranscriptionEvents, TranscripEventCallbacks>(client, TranscriptionEvents.PROCESS_FINISHED, {
        error: error.message,
        message: "There was an error processing your request"
      });
      this.logger.error(`Error processing transcription: ${error.message}`);
    }
  }
}
