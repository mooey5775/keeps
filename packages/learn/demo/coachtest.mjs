// A scripted human against the test server: at each of its decisions, waits for the coach's search,
// prints what the coach says, then plays the coach's pick (or a random move if none), for N decisions.
const N = Number(process.argv[2] ?? 6);
const ws = new WebSocket('ws://localhost:8788/ws');
let code = null, done = 0, busy = false;
const send = (m) => ws.send(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = () => send({ t: 'create', name: 'Tester', bot: true });
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') { code = m.code; console.log('room', code); setTimeout(() => send({ t: 'start' }), 300); }
  if (m.t === 'error') console.log('error', m.message);
  if (m.t !== 'game' || busy) return;
  const legal = m.view.legal.filter((c) => c.type !== 'next-round' && c.type !== 'reveal-duplicity');
  if (!legal.length) return;
  busy = true;
  let c = null;
  for (let i = 0; i < 300; i++) {
    const d = await (await fetch(`http://localhost:8789/coach.json?room=${code}`)).json();
    c = d.coach;
    if (c && c.turn === m.view.turnNumber && ['searched', 'forced', 'error'].includes(c.status)) break;
    await sleep(500);
  }
  console.log(`turn ${c?.turn} ${c?.kind}: ${c?.status} → ${c?.recommended} | network ${c?.before?.toFixed?.(2)} after ${c?.after?.toFixed?.(2)} | ${c?.moves?.slice(0, 4).map((x) => `${x.label} ${Math.round(100 * x.policy)}%/${x.win === null ? '–' : Math.round(100 * x.win) + '%'}`).join('; ')}${c?.error ? ' ERROR ' + c.error : ''}`);
  // Play the coach's pick if the game labels it, else a random legal move.
  send({ t: 'command', command: legal[Math.floor(Math.random() * legal.length)] });
  busy = false;
  if (++done >= N) { send({ t: 'leave' }); setTimeout(() => process.exit(0), 300); }
};
setTimeout(() => { console.log('timeout'); process.exit(1); }, 900000);
