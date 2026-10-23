const ws = new WebSocket(process.argv[2].replace('https://', 'wss://') + '/ws');
ws.onopen = () => ws.send(JSON.stringify({ t: 'create', name: 'TunnelTest', bot: true }));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') { console.log('websocket via ngrok: ok, room', m.code); ws.send(JSON.stringify({ t: 'leave' })); setTimeout(() => process.exit(0), 300); } };
ws.onerror = (e) => { console.log('websocket error', e.message ?? e); process.exit(1); };
setTimeout(() => { console.log('websocket timeout'); process.exit(1); }, 20000);
