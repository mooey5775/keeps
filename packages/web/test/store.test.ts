import type { Move, PlayerView } from '@keeps/engine';
import type { ServerMessage } from '@keeps/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A socket that keeps what's sent on it; the test plays the server. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const draw = (promptId: string): Move => ({ type: 'answer', promptId, answer: { kind: 'action', choice: { kind: 'draw', pile: 0 } } }) as unknown as Move;

/** A game message whose position offers `legal` (the store reads nothing else of the view). */
const position = (legal: Move[]): ServerMessage =>
  ({ t: 'game', view: { legal } as unknown as PlayerView, log: [], names: [], undo: null, reset: true }) as unknown as ServerMessage;

async function seated() {
  vi.resetModules();
  const { roomStore } = await import('../src/net/store.ts');
  roomStore.create('Ann');
  const socket = FakeSocket.last!;
  socket.onopen?.();
  socket.receive({ t: 'welcome', code: 'ABCD', token: 't', playerId: 'me' } as unknown as ServerMessage);
  socket.sent = [];
  const commands = () => socket.sent.filter((m) => (m as { t: string }).t === 'command').map((m) => (m as { command: Move }).command);
  return { roomStore, socket, commands };
}

describe('sending moves', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a move once for a decision, however often it is clicked before the next position', async () => {
    const { roomStore, socket, commands } = await seated();
    socket.receive(position([draw('p3')]));
    roomStore.command(draw('p3'));
    roomStore.command(draw('p3'));
    expect(commands()).toEqual([draw('p3')]);
    // A position from before the move was made (the decision still open): still not sent again.
    socket.receive(position([draw('p3')]));
    roomStore.command(draw('p3'));
    expect(commands()).toEqual([draw('p3')]);
    // The move's position: the next decision's move goes.
    socket.receive(position([draw('p5')]));
    roomStore.command(draw('p5'));
    expect(commands()).toEqual([draw('p3'), draw('p5')]);
  });

  it('lets a refused move be made again, and one lost to a reconnect', async () => {
    const { roomStore, socket, commands } = await seated();
    socket.receive(position([draw('p3'), { type: 'next-round' } as Move]));
    roomStore.command(draw('p3'));
    socket.receive({ t: 'error', message: 'refused' } as ServerMessage);
    roomStore.command(draw('p3'));
    expect(commands()).toEqual([draw('p3'), draw('p3')]);
    roomStore.command({ type: 'next-round' } as Move);
    roomStore.command({ type: 'next-round' } as Move);
    expect(commands()).toHaveLength(3);
    // Reconnected: whatever was in flight may have been lost.
    socket.receive({ t: 'welcome', code: 'ABCD', token: 't', playerId: 'me' } as unknown as ServerMessage);
    roomStore.command({ type: 'next-round' } as Move);
    expect(commands()).toHaveLength(4);
  });
});
