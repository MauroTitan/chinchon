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
    return `<img src="${IMAGE_BASE_URL}cartadecierre.png" class="chinchon-card close-button" onclick="sendChannelMessage('cerrar ${cardId}')" style="cursor:pointer; width:60px; height:auto; margin:2px; border-radius:5px; vertical-align:middle;" title="Cerrar Juego con la 1ra">`;
}

function getMesaCardTag(cardId) {
    const [val, suit] = cardId.split('_');
    const name = numberMap[val] || val;
    const fileName = `${name}de${suit}.png`;
    return `<img src="${IMAGE_BASE_URL}${fileName}" class="chinchon-card" onclick="sendChannelMessage('tomar')" style="cursor:pointer; width:60px; height:auto; margin:2px; border-radius:5px; vertical-align:middle;" title="Tomar ${val} de ${suit}">`;
}

function getDeckCardTag() {
    return `<img src="${IMAGE_BASE_URL}cartadecierre.png" class="chinchon-card" onclick="sendChannelMessage('robar')" style="cursor:pointer; width:60px; height:auto; margin:2px; border-radius:5px; vertical-align:middle;" title="Robar del Mazo">`;
}

// === HAND GROUPING & SORTING UTILITIES ===
const CONSECUTIVE = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

function isEscalera(cards) {
    if (cards.length < 3) return false;
    const suit = cards[0].suit;
    if (!cards.every(c => c.suit === suit)) return false;
    const indices = cards.map(c => CONSECUTIVE.indexOf(c.value)).sort((a, b) => a - b);
    if (indices.some(idx => idx === -1)) return false;
    for (let i = 0; i < indices.length - 1; i++) {
        if (indices[i + 1] !== indices[i] + 1) return false;
    }
    return true;
}

function isGrupo(cards) {
    if (cards.length < 3 || cards.length > 4) return false;
    const val = cards[0].value;
    if (!cards.every(c => c.value === val)) return false;
    const suits = cards.map(c => c.suit);
    const uniqueSuits = new Set(suits);
    return uniqueSuits.size === suits.length;
}

function getSubsets(arr) {
    const res = [];
    function helper(index, current) {
        if (index === arr.length) {
            if (current.length >= 3) {
                res.push(current);
            }
            return;
        }
        helper(index + 1, [...current, arr[index]]);
        helper(index + 1, current);
    }
    helper(0, []);
    return res;
}

function getBestPartition(cards) {
    const validCombos = [];
    const subsets = getSubsets(cards);
    for (const subset of subsets) {
        if (isGrupo(subset) || isEscalera(subset)) {
            validCombos.push(subset);
        }
    }

    let bestLeftovers = [...cards];
    let bestGroups = [];

    function search(availableCards, currentGroups) {
        const currentLeftovers = availableCards;
        const currentScore = getScore(currentLeftovers);
        const bestScore = getScore(bestLeftovers);

        if (currentScore < bestScore) {
            bestLeftovers = [...currentLeftovers];
            bestGroups = [...currentGroups];
        }

        for (const combo of validCombos) {
            if (combo.every(cc => availableCards.some(ac => ac.id === cc.id))) {
                const nextAvailable = availableCards.filter(ac => !combo.some(cc => cc.id === ac.id));
                search(nextAvailable, [...currentGroups, combo]);
            }
        }
    }

    function getScore(leftovers) {
        const count = leftovers.length;
        const sum = leftovers.reduce((s, c) => s + (c.value >= 10 ? 10 : c.value), 0);
        return count * 1000 + sum;
    }

    search(cards, []);

    return {
        groups: bestGroups,
        leftovers: bestLeftovers
    };
}

function organizeHandCards(hand) {
    const partition = getBestPartition(hand);
    const sortedCards = [];

    for (const group of partition.groups) {
        if (isEscalera(group)) {
            group.sort((a, b) => CONSECUTIVE.indexOf(a.value) - CONSECUTIVE.indexOf(b.value));
        }
        sortedCards.push(...group);
    }

    const sortedLeftovers = [...partition.leftovers].sort((a, b) => a.value - b.value);
    sortedCards.push(...sortedLeftovers);

    return {
        cards: sortedCards,
        partition: partition
    };
}

// === SUIT SYMBOLS & LEADERBOARD UTILITIES ===
const SUIT_SYMBOLS = { oro: '◆', copa: '♡', espada: '♤', basto: '☘' };
const CIRCLE_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

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
        this.roundNumber = 0;
        this.eliminatedPlayers = [];
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
        
        // Si iniciamos una nueva partida
        if (this.roundNumber === 0 || this.status === 'ended') {
            this.roundNumber = 1;
            this.eliminatedPlayers = [];
            for (const p of this.players) p.points = 0;
        } else {
            this.roundNumber++;
        }

        this.status = 'playing';
        this.initDeck();
        this.discardPile = [];
        for (const p of this.players) { p.hand = []; for (let i = 0; i < 7; i++) p.hand.push(this.deck.pop()); }
        this.discardPile.push(this.deck.pop());
        this.currentTurn = 0;
        this.phase = 'draw';
        return `¡Juego iniciado! Cartas repartidas para la **Ronda ${this.roundNumber}**.`;
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
        const c = this.discardPile.pop();
        p.hand.push(c);
        this.phase = 'discard';
        return c;
    }

    discard(n, id) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'discard') return "No es tu turno.";
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) return "No tienes esa carta.";
        const c = p.hand.splice(i, 1)[0];
        this.discardPile.push(c);
        if (p.hand.length === 0) return this.endRound(n, true, c, false);
        this.currentTurn = (this.currentTurn + 1) % this.players.length;
        this.phase = 'draw';
        return c;
    }

    close(n, id) {
        const p = this.getCurrentPlayer();
        if (!p || p.nick !== n || this.phase !== 'discard') return "No es tu turno.";
        
        // El jugador tiene 8 cartas en su mano actualmente.
        // Probamos descartar cada una de las 8 cartas para encontrar cuál produce el mejor cierre válido.
        let bestDiscard = null;
        let bestPartition = null;
        let bestScore = Infinity; // Menor score es mejor

        for (let idx = 0; idx < p.hand.length; idx++) {
            const handCopy = [...p.hand];
            const testDiscard = handCopy.splice(idx, 1)[0];
            
            const partition = getBestPartition(handCopy);
            const leftoversCount = partition.leftovers.length;

            let canClose = false;
            if (leftoversCount === 0 || leftoversCount === 1) {
                canClose = true;
            } else if (leftoversCount === 2) {
                const values = partition.leftovers.map(x => x.value);
                if (values.some(v => v === 1 || v === 2 || v === 3)) {
                    canClose = true;
                }
            }

            if (canClose) {
                const sum = partition.leftovers.reduce((s, c) => s + (c.value >= 10 ? 10 : c.value), 0);
                const score = leftoversCount * 1000 + sum;
                if (score < bestScore) {
                    bestScore = score;
                    bestDiscard = testDiscard;
                    bestPartition = partition;
                }
            }
        }

        if (!bestDiscard) {
            return "No puedes cerrar. Necesitas tener máximo 2 cartas sin combinar y al menos una de ellas debe ser de valor 3 o menor.";
        }

        // Realizar el cierre con la mejor carta encontrada
        const i = p.hand.findIndex(c => c.id === bestDiscard.id);
        const c = p.hand.splice(i, 1)[0];

        // Verificar si todas las 7 cartas restantes son del mismo palo (Chinchón)
        const remainingSuits = new Set(p.hand.map(x => x.suit));
        const isChinchon = (bestPartition.leftovers.length === 0 && remainingSuits.size === 1);

        return this.endRound(n, bestPartition.leftovers.length === 0, c, isChinchon);
    }

    endRound(w, ch, c, isChinchon) {
        let r = `¡Ronda terminada! ${w} cerró.\n`;
        
        // Calcular puntos de esta ronda para todos
        const roundPts = {};
        for (const p of this.players) {
            let pts = getBestPartition(p.hand).leftovers.reduce((s, x) => s + (x.value >= 10 ? 10 : x.value), 0);
            if (p.nick === w) {
                pts = isChinchon ? -25 : (ch ? -10 : 0);
            }
            roundPts[p.nick] = pts;
        }

        // Aplicar los puntos al total
        for (const p of this.players) {
            const pts = roundPts[p.nick];
            p.points += pts;
            r += `${p.nick}: +${pts} (Total: ${p.points})\n`;
        }

        // Guardar eliminados de esta ronda y registrar
        const eliminated = [];
        const remainingPlayers = [];
        for (const p of this.players) {
            if (p.points >= 70) {
                eliminated.push(p);
                this.eliminatedPlayers.push({ nick: p.nick, points: p.points, roundEliminated: this.roundNumber });
            } else {
                remainingPlayers.push(p);
            }
        }

        // Mensajes de eliminación dramáticos
        for (const p of eliminated) {
            r += `\n😂 'Hasta Luego' (+70 pts): 💀 ${p.nick}: ${p.points} puntos\n`;
        }

        // Verificar si termina el juego (si queda <= 1 jugador o si hubo Chinchón)
        const isGameOver = (remainingPlayers.length <= 1) || isChinchon;

        if (isGameOver) {
            this.status = 'ended';
            
            // Consolidar todos los jugadores para el ranking
            const allEndedPlayers = [];
            // Sobrevivientes
            for (const p of remainingPlayers) {
                allEndedPlayers.push({ nick: p.nick, points: p.points, survived: true, round: this.roundNumber });
            }
            // Eliminados en esta ronda
            for (const p of eliminated) {
                allEndedPlayers.push({ nick: p.nick, points: p.points, survived: false, round: this.roundNumber });
            }
            // Eliminados en rondas anteriores
            for (const ep of this.eliminatedPlayers) {
                if (!allEndedPlayers.some(x => x.nick === ep.nick)) {
                    allEndedPlayers.push({ nick: ep.nick, points: ep.points, survived: false, round: ep.roundEliminated });
                }
            }

            // Ordenar ranking
            allEndedPlayers.sort((a, b) => {
                if (a.survived !== b.survived) return a.survived ? -1 : 1;
                if (a.round !== b.round) return b.round - a.round;
                return a.points - b.points;
            });

            r += `\n🏆✨ Ganador ✨🏆\n`;
            allEndedPlayers.forEach((p, idx) => {
                const num = CIRCLE_NUMBERS[idx] || `[${idx + 1}]`;
                r += `${num} ${p.nick}: ${p.points} pts (${p.survived ? 'Sobreviviente' : 'Eliminado en Ronda ' + p.round})\n`;
            });
        } else {
            this.status = 'waiting';
            this.players = remainingPlayers; // Solo quedan los sobrevivientes para la siguiente ronda
            r += `\nLa siguiente ronda iniciará automáticamente en 5 segundos...`;
        }

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
        } else if (t === '!stop') {
            if (g.status === 'waiting' && !g.joinTimer) {
                this.send(c, "No hay ninguna partida activa para detener.");
                return;
            }
            if (g.joinTimer) {
                clearTimeout(g.joinTimer);
                g.joinTimer = null;
            }
            g.status = 'waiting';
            g.players = [];
            this.send(c, `Partida/Lobby detenido por ${u}. Escriban !jugar para iniciar otra.`);
        } else if (t === 'join') {
            this.send(c, g.addPlayer(u));
        } else if (t === 'jugar!') {
            if (g.joinTimer) clearTimeout(g.joinTimer);
            this.send(c, g.start());
            if (g.status === 'playing') { this.announce(c); this.hands(c); }
        } else if (t === 'tomar') {
            const r = g.drawFromDiscard(u);
            if (typeof r === 'object') {
                const [val, suit] = r.id.split('_');
                this.send(c, `${u} tomó el ${val} de ${suit}`);
                this.hands(c, u);
            } else this.send(c, r);
        } else if (t === 'robar') {
            const r = g.drawFromDeck(u);
            if (r === true) { this.send(c, `${u} robó del mazo.`); this.hands(c, u); }
            else this.send(c, r);
        } else if (t.startsWith('tirar ')) {
            const r = g.discard(u, t.split(' ')[1]);
            if (typeof r === 'string') {
                this.send(c, r);
                if (g.status === 'waiting' && g.players.length >= 2) {
                    setTimeout(() => {
                        this.send(c, g.start());
                        if (g.status === 'playing') { this.announce(c); this.hands(c); }
                    }, 5000);
                }
            } else {
                const [val, suit] = r.id.split('_');
                this.send(c, `${u} tiró el ${val} de ${suit}`);
                if (g.status === 'playing') { this.announce(c); this.hands(c); }
            }
        } else if (t.startsWith('cerrar ')) {
            const r = g.close(u, t.split(' ')[1]);
            this.send(c, r);
            if (g.status === 'waiting' && g.players.length >= 2) {
                setTimeout(() => {
                    this.send(c, g.start());
                    if (g.status === 'playing') { this.announce(c); this.hands(c); }
                }, 5000);
            }
        } else if (t.includes('@' + BOT_CREDENTIALS.nickname.toLowerCase())) {
            this.hands(c, u);
        }
    }

    getGame(c) { if (!this.games.has(c)) this.games.set(c, new ChinchonGame(c)); return this.games.get(c); }
    send(t, x) { this.ws.send(JSON.stringify({ type: 'message', target: t, text: x })); }
    notice(t, x) { this.ws.send(JSON.stringify({ type: 'notice', target: t, text: x, isPrivate: true })); }
    
    announce(c, showMesa = true) {
        const g = this.getGame(c); const p = g.getCurrentPlayer(); const top = g.discardPile[g.discardPile.length - 1];
        if (showMesa) {
            this.send(c, `Turno de ${p.nick}<br><div class="chinchon-deck-container" style="display: flex; gap: 8px; margin-top: 6px; align-items: center;">${getMesaCardTag(top.id)}${getDeckCardTag()}</div>`);
        } else {
            this.send(c, `Turno de ${p.nick}`);
        }
    }
    
    hands(c, n = null) {
        const g = this.getGame(c); const players = n ? g.players.filter(p => p.nick === n) : g.players;
        for (const p of players) {
            if (n === null && g.status === 'playing' && g.getCurrentPlayer().nick !== p.nick) {
                continue;
            }
            const organized = organizeHandCards(p.hand);
            let cardsHtml = organized.cards.map(x => getCardTag(x.id)).join('');
            if (g.status === 'playing') {
                cardsHtml += getCloseTag(organized.cards[0].id);
            }
            let h = `Tus cartas:<br><div class="chinchon-cards-container" style="display: flex; flex-flow: row wrap; gap: 4px; margin-top: 6px; align-items: center;">${cardsHtml}</div>`;
            this.notice(p.nick, h);
        }
    }
}

new ChinchonBot().connect();
