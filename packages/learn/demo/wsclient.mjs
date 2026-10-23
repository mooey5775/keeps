// A scripted human for the demo: create a room with the bot, start, play a few random legal moves, check the spectator view, leave.
const ws = new WebSocket('ws://localhost:8788/ws');
let moves = 0;
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => send({ t: 'create', name: 'Tester', bot: true });
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') { console.log('room', m.code); setTimeout(() => send({ t: 'start' }), 300); }
  if (m.t === 'error') console.log('error', m.message);
  if (m.t === 'game' && m.view.legal.length && moves < 4) {
    moves++;
    const legal = m.view.legal.filter((c) => c.type !== 'next-round' && c.type !== 'reveal-duplicity');
    setTimeout(() => send({ t: 'command', command: legal[Math.floor(Math.random() * legal.length)] }), 200);
  }
  if (moves >= 4 && m.t === 'game') {
    const s = await (await fetch('http://localhost:8789/spectate.json')).json();
    console.log(JSON.stringify({ room: s.room, turn: s.turn, toMove: s.toMove, players: s.players.map((p) => ({ name: p.name, hand: p.hand, keep: p.keep.length, score: p.score })), piles: s.piles.map((p) => `${p.identity}:${p.cards.length}`), logLines: s.log.length, lastLog: s.log.slice(-3).map((l) => l.text) }, null, 1));
    send({ t: 'leave' });
    setTimeout(() => process.exit(0), 300);
  }
};
setTimeout(() => { console.log('timeout'); process.exit(1); }, 240000);
