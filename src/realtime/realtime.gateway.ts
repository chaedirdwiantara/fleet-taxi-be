import { Logger } from '@nestjs/common';
import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

export interface ImportProgressPayload {
  importId: number;
  processed: number;
  total: number | null;
  percent: number | null;
}

export interface ImportDonePayload {
  importId: number;
  rowsInserted: number;
  durationMs: number;
}

export interface ImportFailedPayload {
  importId: number;
  error: string;
}

/**
 * R1 event catalog (server→client only): import:progress|done|failed.
 * Clients join a per-import room. Future GPS events are reserved, not built.
 */
@WebSocketGateway({ namespace: '/rt', cors: { origin: true, credentials: true } })
export class RealtimeGateway {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  @SubscribeMessage('import:subscribe')
  onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { importId?: number },
  ): { subscribed: boolean } {
    const importId = Number(body?.importId);
    if (!Number.isInteger(importId) || importId <= 0) return { subscribed: false };
    void socket.join(`import:${importId}`);
    return { subscribed: true };
  }

  emitProgress(payload: ImportProgressPayload): void {
    this.server?.to(`import:${payload.importId}`).emit('import:progress', payload);
  }

  emitDone(payload: ImportDonePayload): void {
    this.server?.to(`import:${payload.importId}`).emit('import:done', payload);
    this.logger.log(`import ${payload.importId} done: ${payload.rowsInserted} rows`);
  }

  emitFailed(payload: ImportFailedPayload): void {
    this.server?.to(`import:${payload.importId}`).emit('import:failed', payload);
    this.logger.warn(`import ${payload.importId} failed: ${payload.error}`);
  }
}
