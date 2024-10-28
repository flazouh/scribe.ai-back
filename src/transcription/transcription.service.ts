import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { Socket } from 'socket.io';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import * as ffmpeg from "fluent-ffmpeg";
import { ChunkProcessingData, ChunkStatus, TranscripEventCallbacks, TranscriptionEvents } from './types/transcription.types';
import { sendWSEvent } from './utils';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly openai: OpenAI;
  private readonly CHUNK_DURATION = 60; // 60 seconds

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
          sendWSEvent<TranscriptionEvents, TranscripEventCallbacks>(client, TranscriptionEvents.PROCESSING, {
            chunks: [...chunksState]
          });

          const transcription = await this.transcribeChunk(chunk.path);
          
          // Update chunk with transcription
          chunksState[index] = { 
            id: index, 
            status: ChunkStatus.TRANSCRIBING, 
            transcription 
          };
          sendWSEvent<TranscriptionEvents,TranscripEventCallbacks>(client, TranscriptionEvents.PROCESSING, {
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
              sendWSEvent<TranscriptionEvents,TranscripEventCallbacks>(client, TranscriptionEvents.PROCESSING, {
                chunks: [...chunksState]
              });
            }
          }
          chunksState[index] = {
            id: index,
            status: ChunkStatus.FINISHED,
            transcription,
            correction: correctedText
          };

          sendWSEvent<TranscriptionEvents, TranscripEventCallbacks>(client, TranscriptionEvents.PROCESSING, {
            chunks: [...chunksState]
          });

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

  private async getAudioDuration(inputFile: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Getting audio duration for ${inputFile}`);
      ffmpeg.ffprobe(inputFile, (err, metadata) => {
        if (err) {
          this.logger.error(`Error getting audio duration: ${err.message}`);
          reject(err);
        } else {
          const duration = metadata.format.duration;
          if (!duration) {
            reject(new Error("No duration found in audio metadata"));
          } else {
            this.logger.log(`Audio duration: ${duration} seconds`);
            resolve(duration);
          }
        }
      });
    });
  }

  private async splitAudioIntoChunks(inputFile: string, duration: number, outputFolder: string) {
    this.logger.log(`Starting audio splitting process. Total duration: ${duration}s`);
    const chunks: { path: string; start: number; end: number }[] = [];
    
    for (let start = 0; start < duration; start += this.CHUNK_DURATION) {
      const end = Math.min(start + this.CHUNK_DURATION, duration);
      if (end - start < this.CHUNK_DURATION) {
        continue;
      }
      const outputFile = path.join(outputFolder, `chunk_${start}_${end}.mp3`);
      this.logger.log(`Splitting chunk from ${start} to ${end}`);
      
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

  private async splitChunk(
    inputFile: string,
    outputFile: string,
    startTime: number,
    endTime: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Splitting chunk from ${startTime} to ${endTime}`);
      ffmpeg(inputFile)
        .setStartTime(startTime)
        .duration(endTime - startTime)
        .output(outputFile)
        .on("end", async () => {
          this.logger.log(`Chunk split from ${startTime} to ${endTime}`);
          try {
            const buffer = await fs.promises.readFile(outputFile);
            resolve(buffer);
          } catch (error) {
            reject(error);
          }
        })
        .on("error", (err) => {
          this.logger.error(`Error splitting chunk: ${err}`);
          reject(err);
        })
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
          content: 'Tu es un correcteur de transcription. Corrige les erreurs dans la transcription suivante tout en conservant le sens original. Fais attention à la grammaire, la ponctuation et la clarté. Formate la réponse en markdown.'
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
