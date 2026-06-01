import React from 'react';
import { useWebSocket } from '../../../packages/giojs-react/src/index.ts';

export default function ChatPage(): React.JSX.Element {
  const { send, lastMessage, readyState } = useWebSocket('ws://localhost:3000/chat');
  const [input, setInput] = React.useState('');

  const connected = readyState === WebSocket.OPEN;

  function handleSend(): void {
    if (!input.trim()) return;
    send(input);
    setInput('');
  }

  return (
    <div>
      <h1>WebSocket Echo Chat</h1>
      <p>Status: {connected ? 'connected' : 'connecting...'}</p>
      {lastMessage !== null && (
        <p>Last message: <strong>{lastMessage}</strong></p>
      )}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
        placeholder="Type a message..."
      />
      <button onClick={handleSend} disabled={!connected}>Send</button>
    </div>
  );
}
