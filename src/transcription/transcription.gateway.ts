import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TranscriptionService } from './transcription.service';
import {
  AudioPayload,
  TranscriptionEvents,
} from './types/transcription.types';

enum WebsocketRequestEvents {
  REQUEST_TRANSCRIPTION = 'REQUEST_TRANSCRIPTION',
}

@WebSocketGateway({
  cors: {
    origin: '*', // Configure according to your frontend origin
  },
})
export class TranscriptionGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly transcriptionService: TranscriptionService) { }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage(WebsocketRequestEvents.REQUEST_TRANSCRIPTION)
  async handleTranscription(client: Socket, payload: AudioPayload) {
    try {

      await this.transcriptionService.processAudio(
        { audioData: payload.audioData, client });

    } catch (error) {
      client.emit(TranscriptionEvents.PROCESS_FINISHED, {
        error: error.message
      });
    }
  }
}
