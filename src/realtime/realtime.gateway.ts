import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SessionUser } from '../auth/session.types';

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

/** Import events are admin-only, so only admin sessions may connect/subscribe. */
function isFleetAdmin(user: SessionUser): boolean {
  return user.roles.includes('admin') || user.roles.includes('super_admin');
}

/**
 * R1 event catalog (server→client only): import:progress|done|failed.
 * CORS is pinned to the allowlist by the RedisIoAdapter, and the shared session
 * middleware attaches req.session to the handshake — so the connection is
 * authenticated here and unauthenticated/cross-origin clients are rejected.
 */
@WebSocketGateway({ namespace: '/rt' })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    const request = client.request as unknown as {
      session?: { adminUser?: SessionUser; partnerUser?: SessionUser };
    };
    // Import progress is an admin surface; accept whichever human session the
    // handshake carries and gate on the fleet-admin check below.
    const user = request.session?.adminUser ?? request.session?.partnerUser;
    if (!user || !isFleetAdmin(user)) {
      client.disconnect(true);
      return;
    }
    (client.data as { user?: SessionUser }).user = user;
  }

  @SubscribeMessage('import:subscribe')
  onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { importId?: number },
  ): { subscribed: boolean } {
    const user = (socket.data as { user?: SessionUser }).user;
    if (!user) return { subscribed: false }; // unauthenticated (already disconnected)

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
