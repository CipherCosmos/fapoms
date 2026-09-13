import { SOCKET_RECONNECT_CONFIG } from './socket-transport-config';

describe('SOCKET_RECONNECT_CONFIG', () => {
  it('never gives up, backed off to a 30-second ceiling', () => {
    expect(SOCKET_RECONNECT_CONFIG.reconnection).toBe(true);
    expect(SOCKET_RECONNECT_CONFIG.reconnectionAttempts).toBe(Infinity);
    expect(SOCKET_RECONNECT_CONFIG.reconnectionDelay).toBe(1000);
    expect(SOCKET_RECONNECT_CONFIG.reconnectionDelayMax).toBe(30000);
    expect(SOCKET_RECONNECT_CONFIG.randomizationFactor).toBe(0.5);
  });

  it('tries websocket before falling back to polling', () => {
    expect(SOCKET_RECONNECT_CONFIG.transports).toEqual(['websocket', 'polling']);
  });
});
