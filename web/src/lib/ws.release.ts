/** Drop a socket without Chrome's "WebSocket is closed before the connection
 * is established" when `close()` runs in CONNECTING (Strict Mode, reconnect,
 * or a proxy that never finished the handshake). */
export function releaseWebSocket(socket: WebSocket): void {
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = () => {
      socket.onopen = null;
      socket.close();
    };
    return;
  }
  socket.onopen = null;
  if (socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}
