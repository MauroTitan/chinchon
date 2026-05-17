const WebSocket = require('ws');
const https = require('https');

// === CONFIGURATION ===
const SERVER_URL = 'wss://websocket-chat-u0fd.onrender.com';
const API_HOST = 'websocket-chat-u0fd.onrender.com';
const BOT_CREDENTIALS = { nickname: 'Party', password: 'Titanparty' };
const JOIN_TIME_LIMIT = 30000;
// URL FINAL DE TU GITHUB:
const IMAGE_BASE_URL = 'https://raw.githubusercontent.com/MauroTitan/chinchon/main/cartasespañolas/'; 
// Si subes las cartas, pon la URL aquí

// === HELPER PARA RENDERIZAR CARTAS ===
const numberMap = { 1: 'uno', 2: 'dos', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 10: 'diez', 11: 'once', 12: 'doce' };

function getCardTag(cardId) {
    const [val, suit] = cardId.split('_');
    const name = numberMap[val] || val;
    const fileName = `${name}de${suit}.png`;
    return `<img src="${IMAGE_BASE_URL}${fileName}" class="chinchon-card" onclick="sendChannelMessage('tirar ${cardId}')" style="cursor:pointer; width:60px; height:auto; margin:2px; border-radius:5px; vertical-align:middle;" title="${val} de ${suit}">`;
}

function getCloseTag(cardId) {
    return `<img src="${IMAGE_BASE_URL}cartadecierre.png" class="close-button" onclick="sendChannelMessage('cerrar ${cardId}')" style="cursor:pointer; width:80px; height:auto; margin:2px; vertical-align:middle;" title="Cerrar Juego">`;
}

// === CHINCHON GAME LOGIC ===
class ChinchonGame {
    constructor(channel) {
        this.channel = channel;
        this.players = []; 
        this.deck = [];
        this.discardPile = [];
        this.currentTurn = 0;
        this.phase = 'draw'; 
        this.status = 'waiting'; 
    }

    initDeck() {
        const suits = ['oro', 'copa', 'espada', 'basto'];
        const values = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
        this.deck = [];
        for (const s of suits) for (const v of values) this.deck.push({ id: `${v}_${s}`, suit: s, value: v });
        this.shuffle(this.deck);
    }

    shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

    start() {
        if (this.players.length < 2) return "Se necesitan al menos 2 jugadores.";
        this.status = 'playing';
        this.initDeck();
        this.discardPile = [];
        for (const p of this.players) { p.hand = []; for (let i = 0; i < 7; i++) p.hand.push(this.deck.pop()); }
        this.discardPile.push(this.deck.pop());
        this.currentTurn = 0;
        this.phase = 'draw';
        return "¡Juego iniciado! Cartas repartidas.";
    }

    addPlayer(n) {
        if (this.status !== 'waiting') return "Juego en curso.";
        if (this.players.find(p => p.nick === n)) return "Ya estás dentro.";
        if (this.players.length >= 4) return "Lleno.";
        this.players.push({ nick: n, hand: [], points: 0 });
        return `${n} se unió. (${this.players.length}/4)`;
    }

    getCurrentPlayer() { return this.players[this.currentTurn]; }

    drawFromDeck(n) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'draw') return "No es tu turno.";
        p.hand.push(this.deck.pop());
        this.phase = 'discard';
        return true;
    }

    drawFromDiscard(n) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'draw') return "No es tu turno.";
        if (this.discardPile.length === 0) return "Mesa vacía.";
        p.hand.push(this.discardPile.pop());
        this.phase = 'discard';
        return true;
    }

    discard(n, id) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'discard') return "No es tu turno.";
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) return "No tienes esa carta.";
        const c = p.hand.splice(i, 1)[0];
        this.discardPile.push(c);
        if (p.hand.length === 0) return this.endRound(n, true);
        this.currentTurn = (this.currentTurn + 1) % this.players.length;
        this.phase = 'draw';
        return c;
    }

    close(n, id) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'discard') return "No es tu turno.";
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) return "No tienes esa carta.";
        const c = p.hand.splice(i, 1)[0];
        const pts = p.hand.reduce((s, x) => s + (x.value >= 10 ? 10 : x.value), 0);
        if (pts > 10) { p.hand.push(c); return `Puntos (${pts}) altos para cerrar.`; }
        return this.endRound(n, pts === 0, c);
    }

    endRound(w, ch, c) {
        let r = `¡Ronda terminada! ${w} cerró.\n`;
        for (const p of this.players) {
            let pts = p.hand.reduce((s, x) => s + (x.value >= 10 ? 10 : x.value), 0);
            if (p.nick === w) pts = ch ? -10 : 0;
            p.points += pts;
            r += `${p.nick}: +${pts} (Total: ${p.points})\n`;
        }
        this.players = this.players.filter(p => p.points < 70);
        if (this.players.length <= 1) { r += `Ganador: ${this.players[0] ? this.players[0].nick : 'Nadie'}`; this.status = 'ended'; }
        else { this.status = 'waiting'; r += "Escriban !jugar para otra."; }
        return r;
    }
}

class ChinchonBot {
    constructor() { this.ws = null; this.games = new Map(); }
    
    async login() {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(BOT_CREDENTIALS);
            const options = { hostname: API_HOST, port: 443, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } };
            const req = https.request(options, (res) => {
                let body = ''; res.on('data', (d) => body += d);
                res.on('end', () => { try { const p = JSON.parse(body); if (res.statusCode === 200) resolve(p); else reject(new Error(p.error)); } catch (e) { reject(e); } });
            });
            req.on('error', reject); req.write(data); req.end();
        });
    }

    async connect() {
        try {
            const auth = await this.login();
            this.ws = new WebSocket(SERVER_URL);
            this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'connect', nickname: auth.nickname, token: auth.token })));
            this.ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'message') this.handle(m); } catch (e) {} });
            this.ws.on('close', () => setTimeout(() => this.connect(), 5000));
        } catch (e) { console.error(e); setTimeout(() => this.connect(), 5000); }
    }

    handle(m) {
        const u = m.username; if (u === BOT_CREDENTIALS.nickname) return;
        const t = m.text.toLowerCase().trim();
        const c = m.target.startsWith('#') ? m.target : u;
        const g = this.getGame(c);

        if (t === '!jugar') {
            if (g.status !== 'waiting') return;
            this.send(c, "¡Lobby abierto! Tienen 30s para poner 'join'.");
            g.joinTimer = setTimeout(() => {
                this.send(c, g.start());
                if (g.status === 'playing') { this.announce(c); this.hands(c); }
            }, JOIN_TIME_LIMIT);
        } else if (t === 'join') {
            this.send(c, g.addPlayer(u));
        } else if (t === 'jugar!') {
            if (g.joinTimer) clearTimeout(g.joinTimer);
            this.send(c, g.start());
            if (g.status === 'playing') { this.announce(c); this.hands(c); }
        } else if (t === 'tomar') {
            const r = g.drawFromDiscard(u);
            if (r === true) { this.send(c, `${u} tomó mesa.`); this.hands(c, u); }
            else this.send(c, r);
        } else if (t === 'robar') {
            const r = g.drawFromDeck(u);
            if (r === true) { this.send(c, `${u} robó.`); this.hands(c, u); }
            else this.send(c, r);
        } else if (t.startsWith('tirar ')) {
            const r = g.discard(u, t.split(' ')[1]);
            if (typeof r === 'string') this.send(c, r);
            else { this.send(c, `${u} tiró ${getCardTag(r.id)}`); if (g.status === 'playing') { this.announce(c); this.hands(c); } }
        } else if (t.startsWith('cerrar ')) {
            this.send(c, g.close(u, t.split(' ')[1]));
        } else if (t.includes('@' + BOT_CREDENTIALS.nickname.toLowerCase())) {
            this.hands(c, u);
        }
    }

    getGame(c) { if (!this.games.has(c)) this.games.set(c, new ChinchonGame(c)); return this.games.get(c); }
    send(t, x) { this.ws.send(JSON.stringify({ type: 'message', target: t, text: x })); }
    notice(t, x) { this.ws.send(JSON.stringify({ type: 'notice', target: t, text: x, isPrivate: true })); }
    
    announce(c) {
        const g = this.getGame(c); const p = g.getCurrentPlayer(); const top = g.discardPile[g.discardPile.length - 1];
        this.send(c, `Turno de ${p.nick}<br>Mesa: ${getCardTag(top.id)}<br>Escribe 'tomar' o 'robar'.`);
    }
    
    hands(c, n = null) {
        const g = this.getGame(c); const players = n ? g.players.filter(p => p.nick === n) : g.players;
        for (const p of players) {
            let h = "Tus cartas:<br><div class=\"chinchon-cards-container\" style=\"display: flex; flex-flow: row wrap; gap: 4px; margin-top: 6px; align-items: center;\">" + p.hand.map(x => getCardTag(x.id)).join('') + "</div>";
            if (g.status === 'playing' && g.getCurrentPlayer().nick === p.nick && g.phase === 'discard') {
                h += `<br>${getCloseTag(p.hand[0].id)} <- Cerrar con la 1ra o tira una.`;
            }
            this.notice(p.nick, h);
        }
    }
}

new ChinchonBot().connect();
