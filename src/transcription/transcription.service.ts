import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { Socket } from 'socket.io';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { ChunkProcessingData, ChunkStatus, TranscriptionEvents } from './types/transcription.types';
import { sendWSEvent } from './utils';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly openai: OpenAI;
  private readonly CHUNK_DURATION = 30; // 30 seconds

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
  }

  async processAudio({ audioData, client }: { audioData: Buffer; client: Socket; }) {
    const processingId = uuidv4();
    this.logger.log(`Starting audio processing with ID: ${processingId}`);
    
    const tempDir = tmpdir();
    const inputFile = path.join(tempDir, `${processingId}_input.mp3`);
    const outputFolder = path.join(tempDir, processingId);
    const chunksState: Array<ChunkProcessingData> = [];

    try {
      this.logger.log(`Creating output directory: ${outputFolder}`);
      await fs.promises.mkdir(outputFolder, { recursive: true });
      
      this.logger.log(`Writing input file: ${inputFile}`);
      await fs.promises.writeFile(inputFile, audioData);

      const duration = await this.getAudioDuration(inputFile);
      this.logger.log(`Audio duration: ${duration} seconds`);
      
      const chunks = await this.splitAudioIntoChunks(inputFile, duration, outputFolder);
      this.logger.log(`Split audio into ${chunks.length} chunks`);

      // Initialize chunks state
      chunks.forEach((_, index) => {
        chunksState[index] = { id: index, status: ChunkStatus.SPLITTING };
      });

      // Process chunks in parallel
      await Promise.all(chunks.map(async (chunk, index) => {
        try {
          // Update chunk status to transcribing
          chunksState[index] = { id: index, status: ChunkStatus.TRANSCRIBING };
          sendWSEvent<TranscriptionEvents, any>(client, TranscriptionEvents.PROCESSING, {
            chunks: [...chunksState]
          });

          const transcription = await this.transcribeChunk(chunk.path);
          
          // Update chunk with transcription
          chunksState[index] = { 
            id: index, 
            status: ChunkStatus.TRANSCRIBING, 
            transcription 
          };
          sendWSEvent<TranscriptionEvents, any>(client, TranscriptionEvents.PROCESSING, {
            chunks: [...chunksState]
          });

          // Correct transcription
          const correctionStream = await this.correctTranscription(transcription);
          
          chunksState[index].status = ChunkStatus.CORRECTING;
          let correctedText = '';
          for await (const correction of correctionStream) {
            const content = correction.choices[0]?.delta?.content || '';
            correctedText += content;
            
            if (content) {
              chunksState[index] = {
                id: index,
                status: ChunkStatus.CORRECTING,
                transcription,
                correction: correctedText
              };
              sendWSEvent<TranscriptionEvents, any>(client, TranscriptionEvents.PROCESSING, {
                chunks: [...chunksState]
              });
            }
          }

          return {
            index,
            transcription,
            correction: correctedText
          };

        } catch (error) {
          this.logger.error(`Error processing chunk ${index}: ${error.message}`);
          throw error;
        }
      }));

    } catch (error) {
      this.logger.error(`Failed to process audio ${processingId}:`, error.stack);
      throw error;
    } finally {
      this.logger.log(`Cleaning up temporary files for ${processingId}`);
      await this.cleanup(inputFile, outputFolder);
    }
  }

  private async getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) reject(err);
        resolve(metadata.format.duration || 0);
      });
    });
  }

  private async splitAudioIntoChunks(inputFile: string, duration: number, outputFolder: string) {
    this.logger.log(`Starting audio splitting process. Total duration: ${duration}s`);
    const chunks: { path: string; start: number; end: number }[] = [];
    
    for (let start = 0; start < duration; start += this.CHUNK_DURATION) {
      const end = Math.min(start + this.CHUNK_DURATION, duration);
      const outputFile = path.join(outputFolder, `chunk_${start}_${end}.mp3`);
      
      await this.splitChunk(inputFile, outputFile, start, end);
      
      chunks.push({
        path: outputFile,
        start,
        end
      });
    }

    this.logger.log(`Finished splitting audio into ${chunks.length} chunks`);
    return chunks;
  }

  private async splitChunk(inputFile: string, outputFile: string, start: number, end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .setStartTime(start)
        .duration(end - start)
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  }

  private async transcribeChunk(chunkPath: string): Promise<string> {
    this.logger.log(`Transcribing chunk: ${path.basename(chunkPath)}`);
    const response = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkPath),
      model: 'whisper-1',
    });

    this.logger.log(`Transcription completed for: ${path.basename(chunkPath)}`);
    return response.text;
  }

  private async correctTranscription(text: string) {
    this.logger.log(`Starting transcription correction, text length: ${text.length} characters`);
    return await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a professional transcription editor. Correct any errors in the following transcription while maintaining the original meaning. Focus on grammar, punctuation, and clarity.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      stream: true,
    });
  }

  private async cleanup(inputFile: string, outputFolder: string) {
    try {
      this.logger.log('Starting cleanup of temporary files');
      await fs.promises.unlink(inputFile);
      await fs.promises.rm(outputFolder, { recursive: true });
      this.logger.log('Cleanup completed successfully');
    } catch (error) {
      this.logger.error(`Error cleaning up temporary files: ${error.message}`, error.stack);
    }
  }
}
