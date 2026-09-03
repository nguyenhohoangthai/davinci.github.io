const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function createDeck() {
    const deck = [];
    let id = 1;
    for (let i = 0; i <= 11; i++) {
        deck.push({ id: id++, color: 'black', value: i, isJoker: false, isRevealed: false });
        deck.push({ id: id++, color: 'white', value: i, isJoker: false, isRevealed: false });
    }
    deck.push({ id: id++, color: 'black', value: '-', isJoker: true, isRevealed: false });
    deck.push({ id: id++, color: 'white', value: '-', isJoker: true, isRevealed: false });

    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function tileComparator(a, b) {
    if (a.isJoker || b.isJoker) return 0;
    if (a.value !== b.value) {
        return a.value - b.value;
    }
    if (a.color === 'black' && b.color === 'white') return -1;
    if (a.color === 'white' && b.color === 'black') return 1;
    return 0;
}

function autoInsertNonJoker(hand, newTile) {
    let inserted = false;
    const newHand = [];
    
    for (let i = 0; i < hand.length; i++) {
        const tile = hand[i];
        if (!inserted && !tile.isJoker) {
            if (tileComparator(newTile, tile) < 0) {
                newHand.push(newTile);
                inserted = true;
            }
        }
        newHand.push(tile);
    }
    if (!inserted) {
        newHand.push(newTile);
    }
    return newHand;
}

function checkPlayerEliminated(player) {
    if (!player.hand || player.hand.length === 0) return false;
    return player.hand.every(tile => tile.isRevealed);
}

function getSanitizedRoomState(room, clientSocketId) {
    const isGameOver = room.state === 'game_over';
    
    const sanitizedPlayers = room.players.map(p => {
        const isSelf = p.socketId === clientSocketId;
        const sanitizedHand = p.hand.map(tile => {
            if (isSelf || isGameOver || tile.isRevealed) {
                return { ...tile };
            } else {
                return {
                    id: tile.id,
                    color: tile.color,
                    isRevealed: false,
                    isJoker: false,
                    value: '?'
                };
            }
        });

        return {
            socketId: p.socketId,
            name: p.name,
            coins: p.coins,
            isEliminated: p.isEliminated,
            ready: p.ready,
            isBot: p.isBot || false,
            difficulty: p.difficulty || 'hard',
            handCount: p.hand.length,
            unrevealedCount: p.hand.filter(t => !t.isRevealed).length,
            hand: sanitizedHand
        };
    });

    let sanitizedDrawnTile = null;
    if (room.drawnTile) {
        const activePlayer = room.players[room.currentTurnIndex];
        const isTurnPlayer = activePlayer && activePlayer.socketId === clientSocketId;
        if (isTurnPlayer || room.drawnTile.isRevealed || isGameOver) {
            sanitizedDrawnTile = { ...room.drawnTile };
        } else {
            sanitizedDrawnTile = {
                id: room.drawnTile.id,
                color: room.drawnTile.color,
                isRevealed: false,
                isJoker: false,
                value: '?'
            };
        }
    }

    const tablePool = (room.deck || []).map(t => ({
        id: t.id,
        color: t.color
    }));
    const blackRemaining = tablePool.filter(t => t.color === 'black').length;
    const whiteRemaining = tablePool.filter(t => t.color === 'white').length;

    return {
        roomId: room.roomId,
        hostSocketId: room.hostSocketId,
        state: room.state,
        deckCount: room.deck.length,
        tablePool: tablePool,
        blackRemaining: blackRemaining,
        whiteRemaining: whiteRemaining,
        currentTurnIndex: room.currentTurnIndex,
        currentTurnSocketId: room.players[room.currentTurnIndex] ? room.players[room.currentTurnIndex].socketId : null,
        draftTurnIndex: room.draftTurnIndex !== undefined ? room.draftTurnIndex : 0,
        draftTurnSocketId: room.players[room.draftTurnIndex] ? room.players[room.draftTurnIndex].socketId : null,
        targetDraftCount: 4,
        prepSecondsLeft: room.prepSecondsLeft || 0,
        turnPhase: room.turnPhase,
        drawnTile: sanitizedDrawnTile,
        players: sanitizedPlayers,
        logs: room.logs.slice(-30),
        pendingJokers: room.pendingJokers ? room.pendingJokers[clientSocketId] || null : null
    };
}

function broadcastRoomState(room) {
    room.players.forEach(p => {
        const state = getSanitizedRoomState(room, p.socketId);
        io.to(p.socketId).emit('room_state', state);
    });
}

function logActivity(room, text) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    room.logs.push(`[${time}] ${text}`);
}

function getPublicRoomsList() {
    const list = [];
    for (const code in rooms) {
        const r = rooms[code];
        if (r.state === 'lobby' && r.players.length < 4) {
            list.push({
                roomId: r.roomId,
                hostName: r.players.find(p => p.socketId === r.hostSocketId)?.name || 'Chủ phòng',
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers || 4
            });
        }
    }
    return list;
}

function broadcastPublicRooms() {
    io.emit('public_rooms', getPublicRoomsList());
}

io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);
    socket.emit('public_rooms', getPublicRoomsList());

    socket.on('create_room', ({ playerName, maxPlayers = 4 }) => {
        const cleanName = (playerName || 'Người chơi').trim().slice(0, 15);
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) {
            roomCode = generateRoomCode();
        }

        const room = {
            roomId: roomCode,
            hostSocketId: socket.id,
            maxPlayers: Math.min(Math.max(parseInt(maxPlayers) || 4, 2), 4),
            players: [{
                socketId: socket.id,
                name: cleanName,
                coins: 0,
                hand: [],
                isEliminated: false,
                ready: true
            }],
            state: 'lobby',
            deck: [],
            currentTurnIndex: 0,
            turnPhase: 'drawing',
            drawnTile: null,
            logs: [],
            pendingJokers: {}
        };

        rooms[roomCode] = room;
        socket.join(roomCode);
        socket.roomId = roomCode;

        logActivity(room, `Phòng ${roomCode} được khởi tạo bởi ${cleanName}.`);
        broadcastRoomState(room);
        broadcastPublicRooms();
    });

    socket.on('join_room', ({ roomId, playerName }) => {
        const code = (roomId || '').toUpperCase().trim();
        const room = rooms[code];
        if (!room) {
            return socket.emit('error_message', 'Phòng không tồn tại hoặc đã bị hủy!');
        }
        if (room.state !== 'lobby') {
            return socket.emit('error_message', 'Phòng chơi đã bắt đầu!');
        }
        if (room.players.length >= room.maxPlayers) {
            return socket.emit('error_message', 'Phòng đã đủ số lượng người chơi!');
        }

        const cleanName = (playerName || 'Người chơi').trim().slice(0, 15);
        room.players.push({
            socketId: socket.id,
            name: cleanName,
            coins: 0,
            hand: [],
            isEliminated: false,
            ready: false
        });

        socket.join(code);
        socket.roomId = code;

        logActivity(room, `${cleanName} đã tham gia phòng.`);
        broadcastRoomState(room);
        broadcastPublicRooms();
    });

    socket.on('add_bot', ({ difficulty = 'hard' }) => {
        const room = rooms[socket.roomId];
        if (!room || room.hostSocketId !== socket.id || room.state !== 'lobby') return;
        if (room.players.length >= room.maxPlayers) {
            return socket.emit('error_message', 'Phòng đã đủ số lượng người chơi!');
        }

        const botCount = room.players.filter(p => p.isBot).length + 1;
        const botNames = ['🤖 Bot DaVinci', '🤖 Bot Turing', '🤖 Bot Einstein', '🤖 Bot Ada'];
        const botName = botNames[(botCount - 1) % botNames.length];
        const botId = 'bot_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        room.players.push({
            socketId: botId,
            name: botName,
            isBot: true,
            difficulty: difficulty === 'easy' ? 'easy' : 'hard',
            coins: 0,
            hand: [],
            isEliminated: false,
            ready: true
        });

        logActivity(room, `${botName} (Máy - ${difficulty === 'easy' ? 'Dễ' : 'Khó'}) đã được thêm vào phòng.`);
        broadcastRoomState(room);
        broadcastPublicRooms();
    });

    socket.on('remove_bot', ({ botSocketId }) => {
        const room = rooms[socket.roomId];
        if (!room || room.hostSocketId !== socket.id || room.state !== 'lobby') return;

        const idx = room.players.findIndex(p => p.socketId === botSocketId && p.isBot);
        if (idx !== -1) {
            const removed = room.players.splice(idx, 1)[0];
            logActivity(room, `${removed.name} đã bị xóa khỏi phòng.`);
            broadcastRoomState(room);
            broadcastPublicRooms();
        }
    });

    socket.on('toggle_ready', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'lobby') return;
        const p = room.players.find(x => x.socketId === socket.id);
        if (p) {
            p.ready = !p.ready;
            broadcastRoomState(room);
        }
    });

    socket.on('start_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.hostSocketId !== socket.id) return;
        if (room.players.length < 2) {
            return socket.emit('error_message', 'Cần ít nhất 2 người chơi để bắt đầu!');
        }
        if (room.state !== 'lobby') return;

        room.state = 'shuffling';
        room.deck = createDeck();
        room.logs = [];
        room.currentTurnIndex = 0;
        room.draftTurnIndex = 0;
        room.drawnTile = null;
        room.pendingJokers = {};
        
        logActivity(room, `🃏 Đang xào bài và trải 26 quân bài úp lên bàn cờ...`);
        broadcastRoomState(room);

        setTimeout(() => {
            if (!rooms[room.roomId]) return;

            logActivity(room, `=== BẮT ĐẦU VÁN ĐẤU ===`);
            logActivity(room, `Giai đoạn bốc bài ban đầu: Mỗi người chơi lần lượt bốc 1 quân trên bàn cho đến khi đủ 4 quân.`);

            room.players.forEach(p => {
                p.coins = 0;
                p.isEliminated = false;
                p.hand = [];
            });

            room.state = 'initial_draft';
            room.draftTurnIndex = 0;
            const firstDrafter = room.players[room.draftTurnIndex];
            logActivity(room, `Lượt bốc đầu tiên thuộc về: ${firstDrafter.name}. Hãy chọn 1 quân Trắng hoặc Đen trên bàn!`);

            broadcastRoomState(room);
            broadcastPublicRooms();
            triggerBotTurnIfNeeded(room);
        }, 2200);
    });

    function handlePlayerDraftTile(room, player, tileId) {
        if (!room || room.deck.length === 0) return;

        let tileIndex = -1;
        if (tileId) {
            tileIndex = room.deck.findIndex(t => t.id === tileId);
        }
        if (tileIndex === -1) {
            tileIndex = Math.floor(Math.random() * room.deck.length);
        }

        const tile = room.deck.splice(tileIndex, 1)[0];

        // Add to hand
        if (tile.isJoker) {
            player.hand.push(tile);
        } else {
            player.hand = autoInsertNonJoker(player.hand, tile);
        }

        const colName = tile.color === 'black' ? 'Đen' : 'Trắng';
        logActivity(room, `🎴 ${player.name} đã bốc 1 quân ${colName} (${player.hand.length}/4 quân).`);

        // Check if all players have 4 tiles
        const allHaveFour = room.players.every(p => p.hand.length >= 4);
        if (allHaveFour) {
            startPreparationPhase(room);
        } else {
            room.draftTurnIndex = (room.draftTurnIndex + 1) % room.players.length;
            const nextDrafter = room.players[room.draftTurnIndex];
            logActivity(room, `👉 Lượt bốc tiếp theo: ${nextDrafter.name}`);
            broadcastRoomState(room);
            triggerBotTurnIfNeeded(room);
        }
    }

    function startPreparationPhase(room) {
        room.state = 'prep_phase';
        room.prepSecondsLeft = 10;
        logActivity(room, `🎯 Tất cả người chơi đã bốc đủ 4 quân!`);
        logActivity(room, `⏳ Giai đoạn chuẩn bị bí mật (10 giây): Bạn có thể kiểm tra bài và tinh chỉnh vị trí nếu sở hữu Dash (-)...`);
        broadcastRoomState(room);

        if (room.prepInterval) clearInterval(room.prepInterval);
        room.prepInterval = setInterval(() => {
            if (!rooms[room.roomId] || room.state !== 'prep_phase') {
                clearInterval(room.prepInterval);
                return;
            }
            room.prepSecondsLeft -= 1;
            if (room.prepSecondsLeft <= 0) {
                clearInterval(room.prepInterval);
                startGameplayAfterPrep(room);
            } else {
                broadcastRoomState(room);
            }
        }, 1000);
    }

    function startGameplayAfterPrep(room) {
        if (!room || room.state !== 'prep_phase') return;
        if (room.prepInterval) {
            clearInterval(room.prepInterval);
            room.prepInterval = null;
        }
        room.state = 'in_game';
        room.turnPhase = 'drawing';
        room.currentTurnIndex = 0;
        const firstPlayer = room.players[room.currentTurnIndex];
        logActivity(room, `🏁 VÁN ĐẤU CHÍNH THỨC BẮT ĐẦU!`);
        logActivity(room, `Lượt chơi đầu tiên thuộc về: ${firstPlayer.name}`);
        broadcastRoomState(room);
        triggerBotTurnIfNeeded(room);
    }

    socket.on('draft_tile', ({ tileId }) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'initial_draft') return;

        const currentDrafter = room.players[room.draftTurnIndex];
        if (!currentDrafter || currentDrafter.socketId !== socket.id) return;

        handlePlayerDraftTile(room, currentDrafter, tileId);
    });

    socket.on('finish_prep', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'prep_phase') return;
        startGameplayAfterPrep(room);
    });

    socket.on('move_dash', ({ fromIndex, toIndex }) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'prep_phase') return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const from = parseInt(fromIndex);
        const to = parseInt(toIndex);
        if (isNaN(from) || isNaN(to) || from < 0 || from >= player.hand.length || to < 0 || to >= player.hand.length) return;

        const tile = player.hand[from];
        if (!tile || !tile.isJoker) return;

        player.hand.splice(from, 1);
        player.hand.splice(to, 0, tile);
        // Silent update to preserve secrecy
        broadcastRoomState(room);
    });

    socket.on('place_joker', ({ insertIndex }) => {
        const room = rooms[socket.roomId];
        if (!room) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        // Reposition dash in hand if requested
        const jokerIdx = player.hand.findIndex(t => t.isJoker);
        if (jokerIdx !== -1) {
            const joker = player.hand.splice(jokerIdx, 1)[0];
            const idx = Math.min(Math.max(parseInt(insertIndex) || 0, 0), player.hand.length);
            player.hand.splice(idx, 0, joker);
            broadcastRoomState(room);
        }
    });

    socket.on('draw_tile', ({ tileId } = {}) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'in_game' || room.turnPhase !== 'drawing') return;

        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer.socketId !== socket.id) return;

        if (room.deck.length === 0) {
            logActivity(room, `Kho bài đã hết. ${activePlayer.name} chuyển thẳng sang lượt đoán bài!`);
            room.drawnTile = null;
            room.turnPhase = 'guessing';
            broadcastRoomState(room);
            return;
        }

        let tileIndex = -1;
        if (tileId) {
            tileIndex = room.deck.findIndex(t => t.id === tileId);
        }
        if (tileIndex === -1) {
            tileIndex = Math.floor(Math.random() * room.deck.length);
        }

        const drawn = room.deck.splice(tileIndex, 1)[0];
        room.drawnTile = drawn;

        const colName = drawn.color === 'black' ? 'Đen' : 'Trắng';
        logActivity(room, `🎴 ${activePlayer.name} đã bốc 1 quân bài mới (${colName}) từ bàn.`);

        // Seamless transition without pausing for dash: drawn card stays in drawnTile slot
        room.turnPhase = 'guessing';

        broadcastRoomState(room);
        triggerBotTurnIfNeeded(room);
    });

    socket.on('make_guess', ({ targetSocketId, targetTileIndex, guessedValue }) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'in_game') return;

        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer.socketId !== socket.id) return;

        // Auto draw tile if player hasn't drawn yet
        if (room.turnPhase === 'drawing') {
            if (room.deck.length > 0) {
                const drawn = room.deck.pop();
                room.drawnTile = drawn;
                const colName = drawn.color === 'black' ? 'Đen' : 'Trắng';
                logActivity(room, `🎴 ${activePlayer.name} đã bốc 1 lá bài mới (${colName}).`);
            }
            room.turnPhase = 'guessing';
        }

        if (room.turnPhase === 'action_choice') {
            room.turnPhase = 'guessing';
        }

        if (room.turnPhase === 'guessing') {
            performMakeGuess(room, activePlayer, targetSocketId, targetTileIndex, guessedValue);
        }
    });

    function performMakeGuess(room, activePlayer, targetSocketId, targetTileIndex, guessedValue) {
        const targetPlayer = room.players.find(p => p.socketId === targetSocketId);
        if (!targetPlayer || targetPlayer.socketId === activePlayer.socketId) return false;

        const tileIndex = parseInt(targetTileIndex);
        if (isNaN(tileIndex) || tileIndex < 0 || tileIndex >= targetPlayer.hand.length) return false;

        const targetTile = targetPlayer.hand[tileIndex];
        if (targetTile.isRevealed) return false;

        const cleanGuessedValue = String(guessedValue).trim();
        const colorName = targetTile.color === 'black' ? 'Đen' : 'Trắng';

        let isCorrect = false;
        if (targetTile.isJoker) {
            isCorrect = (cleanGuessedValue === '-');
        } else {
            isCorrect = (parseInt(cleanGuessedValue) === targetTile.value);
        }

        if (isCorrect) {
            targetTile.isRevealed = true;
            activePlayer.coins += 1;

            const valStr = targetTile.isJoker ? 'Dash (-)' : targetTile.value;
            logActivity(room, `🎯 ${activePlayer.name} đoán ĐÚNG lá số [${valStr} ${colorName}] của ${targetPlayer.name}! (+1 Xu, Tổng: ${activePlayer.coins} Xu)`);

            io.to(room.roomId).emit('guess_result', {
                isCorrect: true,
                guesserSocketId: activePlayer.socketId,
                guesserName: activePlayer.name,
                targetName: targetPlayer.name,
                targetColor: targetTile.color,
                targetTileIndex: tileIndex + 1,
                guessedValue: cleanGuessedValue
            });

            if (checkPlayerEliminated(targetPlayer)) {
                targetPlayer.isEliminated = true;
                logActivity(room, `💀 ${targetPlayer.name} đã bị lật hết toàn bộ mật mã!`);
            }

            const anyPlayerEliminated = room.players.some(p => checkPlayerEliminated(p));
            if (anyPlayerEliminated) {
                triggerGameOver(room, `${targetPlayer.name} bị lật hết mật mã!`);
                return true;
            }

            room.turnPhase = 'action_choice';
            broadcastRoomState(room);
            triggerBotTurnIfNeeded(room);
            return true;
        } else {
            let penaltyTile = null;
            logActivity(room, `❌ ${activePlayer.name} đoán SAI lá bài của ${targetPlayer.name} (Đoán: ${cleanGuessedValue}).`);

            if (room.drawnTile) {
                room.drawnTile.isRevealed = true;
                penaltyTile = { ...room.drawnTile };
                const drawn = room.drawnTile;
                room.drawnTile = null;

                if (drawn.isJoker) {
                    activePlayer.hand.push(drawn);
                } else {
                    activePlayer.hand = autoInsertNonJoker(activePlayer.hand, drawn);
                }

                const drawnVal = drawn.isJoker ? 'Dash (-)' : drawn.value;
                const drawnColor = drawn.color === 'black' ? 'Đen' : 'Trắng';
                logActivity(room, `💥 Lá vừa rút [${drawnVal} ${drawnColor}] của ${activePlayer.name} đã bị ép lật ngửa!`);
            } else {
                const unrevealed = activePlayer.hand.find(t => !t.isRevealed);
                if (unrevealed) {
                    unrevealed.isRevealed = true;
                    penaltyTile = { ...unrevealed };
                    const valStr = unrevealed.isJoker ? 'Dash (-)' : unrevealed.value;
                    const colStr = unrevealed.color === 'black' ? 'Đen' : 'Trắng';
                    logActivity(room, `💥 Lá bài [${valStr} ${colStr}] của ${activePlayer.name} đã bị ép lật ngửa!`);
                }
            }

            io.to(room.roomId).emit('guess_result', {
                isCorrect: false,
                guesserSocketId: activePlayer.socketId,
                guesserName: activePlayer.name,
                targetName: targetPlayer.name,
                targetColor: targetTile.color,
                targetTileIndex: tileIndex + 1,
                guessedValue: cleanGuessedValue,
                penaltyTile: penaltyTile
            });

            if (checkPlayerEliminated(activePlayer)) {
                activePlayer.isEliminated = true;
                logActivity(room, `💀 ${activePlayer.name} đã tự làm lật hết mật mã của mình!`);
                if (room.players.some(p => checkPlayerEliminated(p))) {
                    triggerGameOver(room, `${activePlayer.name} bị lật hết mật mã!`);
                    return false;
                }
            }

            advanceTurn(room);
            broadcastRoomState(room);
            triggerBotTurnIfNeeded(room);
            return false;
        }
    }

    function calculateBotGuess(room, botPlayer) {
        const knownTileIds = new Set();
        botPlayer.hand.forEach(t => knownTileIds.add(t.id));
        if (room.drawnTile && room.drawnTile.id) {
            knownTileIds.add(room.drawnTile.id);
        }
        room.players.forEach(p => {
            p.hand.forEach(t => {
                if (t.isRevealed) knownTileIds.add(t.id);
            });
        });

        const fullDeck = [];
        let idCounter = 1;
        for (let i = 0; i <= 11; i++) {
            fullDeck.push({ id: idCounter++, color: 'black', value: i, isJoker: false });
            fullDeck.push({ id: idCounter++, color: 'white', value: i, isJoker: false });
        }
        fullDeck.push({ id: idCounter++, color: 'black', value: '-', isJoker: true });
        fullDeck.push({ id: idCounter++, color: 'white', value: '-', isJoker: true });

        const unknownPool = fullDeck.filter(t => !knownTileIds.has(t.id));

        const targets = [];

        room.players.forEach(targetPlayer => {
            if (targetPlayer.socketId === botPlayer.socketId || targetPlayer.isEliminated) return;

            targetPlayer.hand.forEach((tile, idx) => {
                if (tile.isRevealed) return;

                const colorCandidates = unknownPool.filter(c => c.color === tile.color);
                const validCandidates = [];

                colorCandidates.forEach(cand => {
                    let isValid = true;
                    if (!cand.isJoker) {
                        for (let l = 0; l < idx; l++) {
                            const leftTile = targetPlayer.hand[l];
                            if (leftTile.isRevealed && !leftTile.isJoker) {
                                if (tileComparator(leftTile, cand) >= 0) {
                                    isValid = false;
                                    break;
                                }
                            }
                        }
                        if (isValid) {
                            for (let r = idx + 1; r < targetPlayer.hand.length; r++) {
                                const rightTile = targetPlayer.hand[r];
                                if (rightTile.isRevealed && !rightTile.isJoker) {
                                    if (tileComparator(cand, rightTile) >= 0) {
                                        isValid = false;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (isValid) {
                        validCandidates.push(cand);
                    }
                });

                if (validCandidates.length > 0) {
                    targets.push({
                        targetSocketId: targetPlayer.socketId,
                        targetName: targetPlayer.name,
                        targetTileIndex: idx,
                        color: tile.color,
                        candidates: validCandidates,
                        count: validCandidates.length
                    });
                }
            });
        });

        if (targets.length === 0) return null;

        targets.sort((a, b) => a.count - b.count);

        if (botPlayer.difficulty === 'easy') {
            const randomTarget = targets[Math.floor(Math.random() * targets.length)];
            const randomCand = randomTarget.candidates[Math.floor(Math.random() * randomTarget.candidates.length)];
            return {
                targetSocketId: randomTarget.targetSocketId,
                targetTileIndex: randomTarget.targetTileIndex,
                guessedValue: randomCand.isJoker ? '-' : randomCand.value,
                confidence: 1 / randomTarget.count
            };
        } else {
            const bestTarget = targets[0];
            const chosenCand = bestTarget.candidates[Math.floor(Math.random() * bestTarget.candidates.length)];
            return {
                targetSocketId: bestTarget.targetSocketId,
                targetTileIndex: bestTarget.targetTileIndex,
                guessedValue: chosenCand.isJoker ? '-' : chosenCand.value,
                confidence: 1 / bestTarget.count
            };
        }
    }

    function triggerBotTurnIfNeeded(room) {
        if (!room || room.state === 'lobby' || room.state === 'game_over') return;

        if (room.botTimer) {
            clearTimeout(room.botTimer);
            room.botTimer = null;
        }

        if (room.state === 'initial_draft') {
            const drafter = room.players[room.draftTurnIndex];
            if (!drafter || !drafter.isBot || drafter.isEliminated) return;

            room.botTimer = setTimeout(() => {
                if (!rooms[room.roomId] || room.state !== 'initial_draft') return;
                if (room.deck.length === 0) return;

                const botBlacks = drafter.hand.filter(t => t.color === 'black').length;
                const botWhites = drafter.hand.filter(t => t.color === 'white').length;
                const preferredColor = botBlacks <= botWhites ? 'black' : 'white';

                let candTile = room.deck.find(t => t.color === preferredColor);
                if (!candTile) {
                    candTile = room.deck[0];
                }

                handlePlayerDraftTile(room, drafter, candTile.id);
            }, 900);
            return;
        }

        if (room.state === 'in_game') {
            const activePlayer = room.players[room.currentTurnIndex];
            if (!activePlayer || !activePlayer.isBot || activePlayer.isEliminated) return;

            if (room.turnPhase === 'drawing') {
                room.botTimer = setTimeout(() => {
                    if (!rooms[room.roomId]) return;
                    if (room.deck.length === 0) {
                        logActivity(room, `Kho bài đã hết. 🤖 ${activePlayer.name} chuyển thẳng sang lượt đoán bài!`);
                        room.drawnTile = null;
                        room.turnPhase = 'guessing';
                        broadcastRoomState(room);
                        triggerBotTurnIfNeeded(room);
                        return;
                    }

                    const botBlacks = activePlayer.hand.filter(t => t.color === 'black').length;
                    const botWhites = activePlayer.hand.filter(t => t.color === 'white').length;
                    const prefColor = botBlacks <= botWhites ? 'black' : 'white';

                    let tileIdx = room.deck.findIndex(t => t.color === prefColor);
                    if (tileIdx === -1) tileIdx = Math.floor(Math.random() * room.deck.length);

                    const drawn = room.deck.splice(tileIdx, 1)[0];
                    room.drawnTile = drawn;
                    const colName = drawn.color === 'black' ? 'Đen' : 'Trắng';
                    logActivity(room, `🤖 ${activePlayer.name} đã bốc 1 quân bài mới (${colName}) từ bàn.`);

                    // Directly proceed to guessing
                    room.turnPhase = 'guessing';
                    broadcastRoomState(room);
                    triggerBotTurnIfNeeded(room);
                }, 1200);
                return;
            }

            if (room.turnPhase === 'guessing') {
                room.botTimer = setTimeout(() => {
                    if (!rooms[room.roomId]) return;
                    const guess = calculateBotGuess(room, activePlayer);
                    if (guess) {
                        performMakeGuess(room, activePlayer, guess.targetSocketId, guess.targetTileIndex, guess.guessedValue);
                    } else {
                        logActivity(room, `🤖 ${activePlayer.name} không tìm thấy lá bài nào để đoán, chọn qua lượt.`);
                        advanceTurn(room);
                        broadcastRoomState(room);
                        triggerBotTurnIfNeeded(room);
                    }
                }, 1800);
                return;
            }

            if (room.turnPhase === 'action_choice') {
                room.botTimer = setTimeout(() => {
                    if (!rooms[room.roomId]) return;
                    const nextGuess = calculateBotGuess(room, activePlayer);
                    if (nextGuess && nextGuess.confidence >= 0.5) {
                        room.turnPhase = 'guessing';
                        logActivity(room, `🔄 🤖 ${activePlayer.name} tự tin chọn tiếp tục đoán bài!`);
                        broadcastRoomState(room);
                        triggerBotTurnIfNeeded(room);
                    } else {
                        logActivity(room, `🛡️ 🤖 ${activePlayer.name} cẩn trọng chọn dừng lượt để bảo toàn mật mã.`);
                        if (room.drawnTile) {
                            const drawn = room.drawnTile;
                            room.drawnTile = null;
                            if (drawn.isJoker) {
                                activePlayer.hand.push(drawn);
                            } else {
                                activePlayer.hand = autoInsertNonJoker(activePlayer.hand, drawn);
                            }
                        }
                        advanceTurn(room);
                        broadcastRoomState(room);
                        triggerBotTurnIfNeeded(room);
                    }
                }, 1500);
                return;
            }
        }
    }

    socket.on('player_action_choice', ({ choice }) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'in_game' || room.turnPhase !== 'action_choice') return;

        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer.socketId !== socket.id) return;

        if (choice === 'guess_again') {
            room.turnPhase = 'guessing';
            logActivity(room, `🔄 ${activePlayer.name} chọn tiếp tục đoán bài!`);
            broadcastRoomState(room);
            triggerBotTurnIfNeeded(room);
        } else if (choice === 'pass_turn') {
            logActivity(room, `🛡️ ${activePlayer.name} dừng lượt và bảo toàn mật mã.`);
            if (room.drawnTile) {
                const drawn = room.drawnTile;
                room.drawnTile = null;
                if (drawn.isJoker) {
                    activePlayer.hand.push(drawn);
                } else {
                    activePlayer.hand = autoInsertNonJoker(activePlayer.hand, drawn);
                }
            }
            advanceTurn(room);
            broadcastRoomState(room);
            triggerBotTurnIfNeeded(room);
        }
    });

    function advanceTurn(room) {
        const activePlayer = room.players[room.currentTurnIndex];
        if (activePlayer && room.drawnTile) {
            const drawn = room.drawnTile;
            room.drawnTile = null;
            if (drawn.isJoker) {
                activePlayer.hand.push(drawn);
            } else {
                activePlayer.hand = autoInsertNonJoker(activePlayer.hand, drawn);
            }
        }

        let nextIndex = (room.currentTurnIndex + 1) % room.players.length;
        let count = 0;
        while (room.players[nextIndex].isEliminated && count < room.players.length) {
            nextIndex = (nextIndex + 1) % room.players.length;
            count++;
        }

        room.currentTurnIndex = nextIndex;
        room.turnPhase = 'drawing';
        const nextPlayer = room.players[room.currentTurnIndex];
        logActivity(room, `➡️ Chuyển lượt sang: ${nextPlayer.name}`);
    }

    function triggerGameOver(room, reason) {
        room.state = 'game_over';
        room.players.forEach(p => {
            p.hand.forEach(t => t.isRevealed = true);
        });

        logActivity(room, `=================================`);
        logActivity(room, `🏆 KẾT THÚC GAME (${reason}) 🏆`);
        
        const sorted = [...room.players].sort((a, b) => b.coins - a.coins);
        logActivity(room, `🥇 CHIẾN THẮNG: ${sorted[0].name} với ${sorted[0].coins} Xu!`);
        logActivity(room, `=================================`);

        broadcastRoomState(room);
        broadcastPublicRooms();
    }

    socket.on('restart_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.hostSocketId !== socket.id) return;
        
        room.state = 'lobby';
        room.players.forEach(p => {
            p.ready = (p.socketId === room.hostSocketId);
            p.hand = [];
            p.coins = 0;
            p.isEliminated = false;
        });
        room.logs = [];
        logActivity(room, `Chủ phòng đã làm mới bàn chơi.`);
        broadcastRoomState(room);
        broadcastPublicRooms();
    });

    socket.on('disconnect', () => {
        console.log(`[Socket Disconnected] ID: ${socket.id}`);
        const code = socket.roomId;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        
        if (playerIndex !== -1) {
            const disconnectedPlayer = room.players[playerIndex];
            logActivity(room, `⚠️ ${disconnectedPlayer.name} đã rời khỏi phòng.`);

            room.players.splice(playerIndex, 1);

            if (room.players.length === 0) {
                delete rooms[code];
                broadcastPublicRooms();
                return;
            }

            if (room.hostSocketId === socket.id) {
                room.hostSocketId = room.players[0].socketId;
                logActivity(room, `👑 ${room.players[0].name} trở thành Chủ phòng mới.`);
            }

            if (room.state === 'in_game' || room.state === 'joker_setup' || room.state === 'shuffling') {
                if (room.players.length < 2) {
                    triggerGameOver(room, `Số người chơi còn lại ít hơn 2.`);
                } else {
                    if (room.currentTurnIndex >= room.players.length) {
                        room.currentTurnIndex = 0;
                    }
                    broadcastRoomState(room);
                }
            } else {
                broadcastRoomState(room);
                broadcastPublicRooms();
            }
        }
    });
});

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) {
        return next();
    }
    const publicIndex = path.join(__dirname, 'public', 'index.html');
    const rootIndex = path.join(__dirname, 'index.html');
    if (fs.existsSync(publicIndex)) {
        return res.sendFile(publicIndex);
    } else if (fs.existsSync(rootIndex)) {
        return res.sendFile(rootIndex);
    } else {
        return res.status(404).send('Không tìm thấy file index.html');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`  MẬT MÃ DAVINCI ONLINE SERVER đang chạy!`);
    console.log(`  Port:       ${PORT}`);
    console.log(`  Local URL:  http://localhost:${PORT}`);
    console.log(`=================================================`);
});

module.exports = server;

