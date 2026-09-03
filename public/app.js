// Socket.IO Client Connection
const socket = io();

// DEBUG: theo dõi kết nối socket - nếu bị "disconnect" giữa ván, bạn sẽ
// bị server xóa khỏi phòng và giao diện sẽ đứng hình như bị khoá.
socket.on('connect', () => console.log('[DEBUG] socket connected:', socket.id));
socket.on('disconnect', (reason) => console.warn('[DEBUG] socket DISCONNECTED! reason:', reason));
socket.on('connect_error', (err) => console.error('[DEBUG] socket connect_error:', err));

// State
let currentRoomState = null;
let selectedTarget = null;
let selectedGuessValue = null;
let lastSeenDrawnTileId = null;

// Audio Synthesizer using Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    const now = audioCtx.currentTime;

    if (type === 'shuffle') {
        for (let i = 0; i < 12; i++) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(200 + Math.random() * 200, now + i * 0.08);
            gain.gain.setValueAtTime(0.2, now + i * 0.08);
            gain.gain.linearRampToValueAtTime(0.01, now + i * 0.08 + 0.06);
            osc.start(now + i * 0.08);
            osc.stop(now + i * 0.08 + 0.06);
        }
    } else if (type === 'flip' || type === 'draw') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.12);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
    } else if (type === 'correct') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.12);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'wrong') {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.linearRampToValueAtTime(100, now + 0.3);
        gain.gain.setValueAtTime(0.45, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'win') {
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, i) => {
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.connect(g);
            g.connect(audioCtx.destination);
            o.type = 'triangle';
            o.frequency.setValueAtTime(freq, now + i * 0.12);
            g.gain.setValueAtTime(0.3, now + i * 0.12);
            g.gain.linearRampToValueAtTime(0.01, now + i * 0.12 + 0.25);
            o.start(now + i * 0.12);
            o.stop(now + i * 0.12 + 0.25);
        });
    }
}

// DOM Elements
const screenLobby = document.getElementById('screen-lobby');
const screenRoomWaiting = document.getElementById('screen-room-waiting');
const screenGameBoard = document.getElementById('screen-game-board');

// Lobby Elements
const inputPlayerName = document.getElementById('input-player-name');
const selectMaxPlayers = document.getElementById('select-max-players');
const btnCreateRoom = document.getElementById('btn-create-room');
const inputRoomCode = document.getElementById('input-room-code');
const btnJoinRoom = document.getElementById('btn-join-room');
const publicRoomsList = document.getElementById('public-rooms-list');
const publicRoomsCount = document.getElementById('public-rooms-count');

// Room Waiting Elements
const displayRoomCode = document.getElementById('display-room-code');
const btnCopyCode = document.getElementById('btn-copy-code');
const roomPlayersGrid = document.getElementById('room-players-grid');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const btnToggleReady = document.getElementById('btn-toggle-ready');
const readyBtnText = document.getElementById('ready-btn-text');
const btnAddBot = document.getElementById('btn-add-bot');
const btnStartGame = document.getElementById('btn-start-game');

// Game Board Elements
const gameDisplayRoomCode = document.getElementById('game-display-room-code');
const turnBannerText = document.getElementById('turn-banner-text');
const btnInGameLeave = document.getElementById('btn-in-game-leave');
const drawActionBox = document.getElementById('draw-action-box');
const myPlayerName = document.getElementById('my-player-name');
const myCoinsCount = document.getElementById('my-coins-count');
const myTilesRack = document.getElementById('my-tiles-rack');
const myDrawnTileSlot = document.getElementById('my-drawn-tile-slot');
const myDrawnTileCardContainer = document.getElementById('my-drawn-tile-card-container');

// Table Pool & Prep Banner
const tablePoolContainer = document.getElementById('table-pool-container');
const tablePoolTiles = document.getElementById('table-pool-tiles');
const deckBlackCount = document.getElementById('deck-black-count');
const deckWhiteCount = document.getElementById('deck-white-count');
const prepPhaseBanner = document.getElementById('prep-phase-banner');
const prepCountdown = document.getElementById('prep-countdown');
const btnFinishPrep = document.getElementById('btn-finish-prep');

// Seats & Overlays
const seatTop = document.getElementById('seat-top');
const seatLeft = document.getElementById('seat-left');
const seatRight = document.getElementById('seat-right');
const shufflingOverlay = document.getElementById('shuffling-overlay');

// Floating Guess Dock (Non-blocking)
const guessDock = document.getElementById('guess-dock');
const btnCloseGuessDock = document.getElementById('btn-close-guess-dock');
const btnCancelGuess = document.getElementById('btn-cancel-guess');
const btnConfirmGuess = document.getElementById('btn-confirm-guess');
const guessDockDesc = document.getElementById('guess-dock-desc');
const guessDockColorBadge = document.getElementById('guess-dock-color-badge');

// Modals
const modalDrawnReveal = document.getElementById('modal-drawn-reveal');
const drawnTileBigDisplay = document.getElementById('drawn-tile-big-display');
const btnCloseDrawnReveal = document.getElementById('btn-close-drawn-reveal');

const modalWrongGuess = document.getElementById('modal-wrong-guess');
const wrongGuessDesc = document.getElementById('wrong-guess-desc');
const wrongGuessRevealedCardContainer = document.getElementById('wrong-guess-revealed-card-container');
const btnCloseWrongGuess = document.getElementById('btn-close-wrong-guess');

const modalActionChoice = document.getElementById('modal-action-choice');
const btnChoiceAgain = document.getElementById('btn-choice-again');
const btnChoicePass = document.getElementById('btn-choice-pass');

const modalGameOver = document.getElementById('modal-game-over');
const gameOverReason = document.getElementById('game-over-reason');
const rankingList = document.getElementById('ranking-list');
const btnRestartGame = document.getElementById('btn-restart-game');
const btnEndgameLeave = document.getElementById('btn-endgame-leave');

if (localStorage.getItem('davinci_player_name')) {
    inputPlayerName.value = localStorage.getItem('davinci_player_name');
}

function showScreen(screenId) {
    [screenLobby, screenRoomWaiting, screenGameBoard].forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

socket.on('error_message', (msg) => alert(msg));

// LISTEN FOR GUESS RESULT EVENT (FOR ALL PLAYERS)
socket.on('guess_result', (data) => {
    showGuessAnnouncement(data);

    if (!data.isCorrect) {
        playSound('wrong');

        // Only pop wrong guess modal if IT WAS ME WHO GUESSED WRONG
        if (data.guesserSocketId === socket.id) {
            wrongGuessDesc.innerHTML = `Bạn đã đoán SAI lá bài của <strong>${data.targetName}</strong> (Dự đoán: <strong>${data.guessedValue}</strong>)!`;

            if (data.penaltyTile) {
                const valStr = data.penaltyTile.isJoker ? '-' : data.penaltyTile.value;
                wrongGuessRevealedCardContainer.innerHTML = `
                    <div class="tile-card tile-${data.penaltyTile.color} revealed">
                        <span class="tile-value">${valStr}</span>
                    </div>
                `;
            } else {
                wrongGuessRevealedCardContainer.innerHTML = '';
            }

            openModal(modalWrongGuess);
        }
    } else {
        playSound('correct');
    }
});

function showGuessAnnouncement(data) {
    const banner = document.getElementById('guess-announcement-banner');
    const content = document.getElementById('announcement-content');
    if (!banner || !content) return;

    const colorText = data.targetColor === 'black' ? 'Đen' : 'Trắng';
    const tileValStr = data.guessedValue === '-' ? 'Dash (-)' : data.guessedValue;
    const tilePosText = data.targetTileIndex ? `thứ ${data.targetTileIndex}` : '';

    if (data.isCorrect) {
        banner.className = 'guess-announcement-banner is-correct active';
        content.innerHTML = `
            <div class="announcement-icon"><i class="fa-solid fa-bullseye"></i></div>
            <div class="announcement-text">
                <span class="highlight-guesser">${data.guesserName}</span> đã đoán <strong style="color: #6ee7b7;">ĐÚNG</strong> 
                lá bài <strong>[${tileValStr} ${colorText}]</strong> (${tilePosText}) của <strong>${data.targetName}</strong>! 🎯 (+1 Xu)
            </div>
        `;
    } else {
        banner.className = 'guess-announcement-banner is-wrong active';
        let penaltyText = '';
        if (data.penaltyTile) {
            const penVal = data.penaltyTile.isJoker ? 'Dash (-)' : data.penaltyTile.value;
            const penCol = data.penaltyTile.color === 'black' ? 'Đen' : 'Trắng';
            penaltyText = ` 💥 <strong>${data.guesserName}</strong> bị lật ngửa lá <strong>[${penVal} ${penCol}]</strong>!`;
        }

        content.innerHTML = `
            <div class="announcement-icon"><i class="fa-solid fa-circle-xmark"></i></div>
            <div class="announcement-text">
                <span class="highlight-guesser">${data.guesserName}</span> đã đoán <strong style="color: #fca5a5;">SAI</strong> 
                lá ${tilePosText} (${colorText}) của <strong>${data.targetName}</strong> (Đoán: ${tileValStr})!${penaltyText}
            </div>
        `;
    }

    if (window.announcementTimeout) clearTimeout(window.announcementTimeout);
    window.announcementTimeout = setTimeout(() => {
        banner.classList.remove('active');
    }, 4500);
}

btnCloseWrongGuess.addEventListener('click', () => closeModal(modalWrongGuess));

// PUBLIC ROOMS EVENT
socket.on('public_rooms', (rooms) => {
    publicRoomsCount.innerText = rooms.length;
    if (rooms.length === 0) {
        publicRoomsList.innerHTML = '<div class="empty-list-text">Không có phòng chờ công khai nào. Hãy tạo phòng mới!</div>';
        return;
    }

    publicRoomsList.innerHTML = rooms.map(r => `
        <div class="room-item-row">
            <div>
                <strong>Phòng ${r.roomId}</strong> (Chủ: ${r.hostName})
            </div>
            <div>
                <span class="badge-online">${r.playerCount}/${r.maxPlayers} người</span>
                <button class="btn btn-sm btn-secondary btn-quick-join" data-code="${r.roomId}">Vào</button>
            </div>
        </div>
    `).join('');

    document.querySelectorAll('.btn-quick-join').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const code = e.target.dataset.code;
            inputRoomCode.value = code;
            joinRoom();
        });
    });
});

// CREATE & JOIN ROOMS
btnCreateRoom.addEventListener('click', () => {
    const name = inputPlayerName.value.trim();
    if (!name) return alert('Vui lòng nhập tên người chơi!');
    localStorage.setItem('davinci_player_name', name);
    const maxPlayers = selectMaxPlayers.value;
    socket.emit('create_room', { playerName: name, maxPlayers });
});

function joinRoom() {
    const name = inputPlayerName.value.trim();
    const code = inputRoomCode.value.trim().toUpperCase();
    if (!name) return alert('Vui lòng nhập tên người chơi!');
    if (!code) return alert('Vui lòng nhập mã phòng!');
    localStorage.setItem('davinci_player_name', name);
    socket.emit('join_room', { roomId: code, playerName: name });
}

btnJoinRoom.addEventListener('click', joinRoom);
inputRoomCode.addEventListener('keyup', (e) => { if (e.key === 'Enter') joinRoom(); });

btnCopyCode.addEventListener('click', () => {
    if (currentRoomState) {
        navigator.clipboard.writeText(currentRoomState.roomId);
        alert(`Đã sao chép mã phòng: ${currentRoomState.roomId}`);
    }
});

btnLeaveRoom.addEventListener('click', () => location.reload());
btnInGameLeave.addEventListener('click', () => location.reload());
btnEndgameLeave.addEventListener('click', () => location.reload());

btnToggleReady.addEventListener('click', () => socket.emit('toggle_ready'));
btnStartGame.addEventListener('click', () => socket.emit('start_game'));
btnRestartGame.addEventListener('click', () => socket.emit('restart_game'));
if (btnAddBot) {
    btnAddBot.addEventListener('click', () => socket.emit('add_bot', { difficulty: 'hard' }));
}

// MAIN ROOM STATE UPDATE LISTENER
socket.on('room_state', (room) => {
    currentRoomState = room;

    // DEBUG: In ra lý do vì sao bài đối thủ có/không thể click được.
    // Mở Console (F12) để xem log này mỗi khi trạng thái phòng cập nhật.
    console.log('[DEBUG room_state]', {
        mySocketId: socket.id,
        currentTurnSocketId: room.currentTurnSocketId,
        isMyTurn: room.currentTurnSocketId === socket.id,
        roomState: room.state,
        turnPhase: room.turnPhase,
        socketConnected: socket.connected
    });

    if (room.state === 'lobby') {
        shufflingOverlay.classList.remove('active');
        showScreen('screen-room-waiting');
        renderRoomWaiting(room);
        closeAllModals();
        closeGuessDock();

    } else if (room.state === 'shuffling') {
        showScreen('screen-game-board');
        shufflingOverlay.classList.add('active');
        playSound('shuffle');
        closeGuessDock();

    } else if (room.state === 'initial_draft') {
        shufflingOverlay.classList.remove('active');
        showScreen('screen-game-board');
        renderGameBoard(room);
        closeGuessDock();

    } else if (room.state === 'prep_phase') {
        shufflingOverlay.classList.remove('active');
        showScreen('screen-game-board');
        renderGameBoard(room);
        closeGuessDock();

    } else if (room.state === 'in_game') {
        shufflingOverlay.classList.remove('active');
        showScreen('screen-game-board');
        renderGameBoard(room);

        const isMyTurn = (room.currentTurnSocketId === socket.id);

        // PROMINENT DRAWN TILE POPUP REVEAL FOR CURRENT PLAYER
        if (isMyTurn && room.drawnTile && room.drawnTile.id !== lastSeenDrawnTileId) {
            lastSeenDrawnTileId = room.drawnTile.id;
            openDrawnTileRevealModal(room.drawnTile);
        }

        // Action Choice Modal for correct guesser
        if (room.turnPhase === 'action_choice' && isMyTurn) {
            openModal(modalActionChoice);
        } else {
            closeModal(modalActionChoice);
        }

        if (!isMyTurn || room.turnPhase !== 'guessing') {
            closeGuessDock();
        }

    } else if (room.state === 'game_over') {
        shufflingOverlay.classList.remove('active');
        showScreen('screen-game-board');
        renderGameBoard(room);
        renderGameOverModal(room);
        closeGuessDock();
        playSound('win');
    }
});

// OPEN DRAWN TILE REVEAL MODAL
function openDrawnTileRevealModal(tile) {
    const displayVal = tile.isJoker ? '-' : tile.value;

    drawnTileBigDisplay.innerHTML = `
        <div class="tile-card tile-${tile.color} revealed">
            <span class="tile-value">${displayVal}</span>
        </div>
    `;
    playSound('draw');
    openModal(modalDrawnReveal);

    if (window.drawnRevealTimeout) clearTimeout(window.drawnRevealTimeout);
    window.drawnRevealTimeout = setTimeout(() => {
        closeModal(modalDrawnReveal);
    }, 2800);
}

btnCloseDrawnReveal.addEventListener('click', () => closeModal(modalDrawnReveal));
if (modalDrawnReveal) {
    modalDrawnReveal.addEventListener('click', () => closeModal(modalDrawnReveal));
}

// GLOBAL HANDLER FOR CLICKING TARGETABLE OPPONENT TILES TO GUESS
window.handleTargetTileClick = function(tileEl, event) {
    if (!tileEl) return;

    closeModal(modalDrawnReveal);

    if (currentRoomState && currentRoomState.turnPhase === 'action_choice') {
        socket.emit('player_action_choice', { choice: 'guess_again' });
        closeModal(modalActionChoice);
    }

    const targetSocketId = tileEl.getAttribute('data-target-socket');
    const targetTileIndex = parseInt(tileEl.getAttribute('data-target-index'));
    const color = tileEl.getAttribute('data-color');
    const oppName = tileEl.getAttribute('data-name');

    if (targetSocketId && !isNaN(targetTileIndex)) {
        openGuessDock(targetSocketId, targetTileIndex, color, oppName, tileEl);
    }
};

document.addEventListener('click', (e) => {
    const tileEl = e.target.closest('.tile-card.targetable');
    if (tileEl) {
        window.handleTargetTileClick(tileEl, e);
    }
});

// RENDER ROOM WAITING LOBBY
function renderRoomWaiting(room) {
    displayRoomCode.innerText = room.roomId;
    const me = room.players.find(p => p.socketId === socket.id);
    const isHost = (room.hostSocketId === socket.id);

    if (me) {
        readyBtnText.innerText = me.ready ? 'Hủy Sẵn Sàng' : 'Sẵn Sàng';
        btnToggleReady.className = me.ready ? 'btn btn-secondary' : 'btn btn-primary';
    }

    btnStartGame.style.display = isHost ? 'inline-flex' : 'none';
    if (btnAddBot) {
        btnAddBot.style.display = (isHost && room.players.length < (room.maxPlayers || 4)) ? 'inline-flex' : 'none';
    }

    roomPlayersGrid.innerHTML = room.players.map(p => {
        const pIsHost = p.socketId === room.hostSocketId;
        const cardClass = `player-slot-card ${pIsHost ? 'is-host' : ''} ${p.ready ? 'is-ready' : ''}`;
        const avatarIcon = p.isBot ? 'fa-solid fa-robot text-gold' : 'fa-solid fa-user-secret';
        const readyText = p.isBot
            ? `<span class="bot-badge">🤖 BOT (${p.difficulty === 'easy' ? 'Dễ' : 'Khó'})</span>`
            : (pIsHost ? 'Chủ phòng' : (p.ready ? '✓ Đã sẵn sàng' : 'Chưa sẵn sàng'));
        const removeBotBtn = (isHost && p.isBot)
            ? `<button class="btn btn-danger-ghost btn-remove-bot" data-botid="${p.socketId}">Xóa Bot</button>`
            : '';

        return `
            <div class="${cardClass}">
                ${pIsHost ? '<i class="fa-solid fa-crown host-crown"></i>' : ''}
                <div class="player-avatar"><i class="${avatarIcon}"></i></div>
                <div class="player-name-display">${p.name} ${p.socketId === socket.id ? '(Bạn)' : ''}</div>
                <div class="player-ready-status">${readyText}</div>
                ${removeBotBtn}
            </div>
        `;
    }).join('');

    document.querySelectorAll('.btn-remove-bot').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const botSocketId = e.currentTarget.dataset.botid;
            socket.emit('remove_bot', { botSocketId });
        });
    });
}

// RENDER GAME BOARD (POKER 4-CORNER TABLE LAYOUT)
function renderGameBoard(room) {
    if (gameDisplayRoomCode) gameDisplayRoomCode.innerText = room.roomId;

    const me = room.players.find(p => p.socketId === socket.id);
    const isMyTurn = (room.currentTurnSocketId === socket.id);
    const turnPlayer = room.players.find(p => p.socketId === room.currentTurnSocketId);

    // Render Center Table Pool
    renderTablePool(room);

    // Turn Banner & Prep Phase Banner
    if (room.state === 'initial_draft') {
        if (prepPhaseBanner) prepPhaseBanner.style.display = 'none';
        const isMyDraftTurn = (room.draftTurnSocketId === socket.id);
        const drafter = room.players[room.draftTurnIndex];
        if (isMyDraftTurn) {
            turnBannerText.innerHTML = `<span style="color: var(--gold);">LƯỢT BẠN BỐC BÀI BAN ĐẦU!</span> (Chọn 1 quân trên bàn)`;
        } else {
            const count = drafter ? drafter.handCount : 0;
            turnBannerText.innerHTML = `Đang chờ <strong>${drafter ? drafter.name : ''}</strong> bốc bài (${count}/4)...`;
        }
    } else if (room.state === 'prep_phase') {
        if (prepPhaseBanner) {
            prepPhaseBanner.style.display = 'block';
            if (prepCountdown) prepCountdown.innerText = room.prepSecondsLeft || 0;
        }
        turnBannerText.innerHTML = `<span style="color: var(--emerald);">GIAI ĐOẠN CHUẨN BỊ MẬT MÃ</span> (${room.prepSecondsLeft || 0}s)`;
    } else if (room.state === 'in_game') {
        if (prepPhaseBanner) prepPhaseBanner.style.display = 'none';
        if (isMyTurn) {
            turnBannerText.innerHTML = `<span style="color: var(--gold);">ĐẾN LƯỢT BẠN!</span> (${getTurnPhaseText(room.turnPhase)})`;
        } else {
            turnBannerText.innerHTML = `Đang chờ <strong>${turnPlayer ? turnPlayer.name : ''}</strong> (${getTurnPhaseText(room.turnPhase)})...`;
        }
    }

    // Draw hint box
    if (isMyTurn && room.turnPhase === 'drawing' && room.state === 'in_game') {
        drawActionBox.style.display = 'block';
    } else {
        drawActionBox.style.display = 'none';
    }

    // DYNAMICALLY MAP OPPONENTS TO SEATS
    const opponents = room.players.filter(p => p.socketId !== socket.id);

    seatTop.innerHTML = '<div class="empty-seat-text">Vị trí trống</div>';
    seatLeft.innerHTML = '<div class="empty-seat-text">Vị trí trống</div>';
    seatRight.innerHTML = '<div class="empty-seat-text">Vị trí trống</div>';

    if (opponents.length === 1) {
        renderOpponentCardInSeat(seatTop, opponents[0], isMyTurn, room);
    } else if (opponents.length === 2) {
        renderOpponentCardInSeat(seatLeft, opponents[0], isMyTurn, room);
        renderOpponentCardInSeat(seatRight, opponents[1], isMyTurn, room);
    } else if (opponents.length >= 3) {
        renderOpponentCardInSeat(seatLeft, opponents[0], isMyTurn, room);
        renderOpponentCardInSeat(seatTop, opponents[1], isMyTurn, room);
        renderOpponentCardInSeat(seatRight, opponents[2], isMyTurn, room);
    }

    // Render My Rack with Dash Shifting Controls
    if (me) {
        myPlayerName.innerText = `${me.name} (Bạn)`;
        myCoinsCount.innerText = me.coins;

        myTilesRack.innerHTML = me.hand.map((tile, idx) => {
            const tileClass = `tile-card tile-${tile.color} ${tile.isRevealed ? 'revealed' : ''}`;
            const displayVal = tile.isJoker ? '-' : tile.value;

            let shiftControls = '';
            if (tile.isJoker && room.state === 'prep_phase') {
                const canLeft = idx > 0;
                const canRight = idx < me.hand.length - 1;
                shiftControls = `
                    <div class="dash-shift-btns">
                        ${canLeft ? `<button class="btn-shift-dash" title="Dời sang trái" onclick="moveDashTile(${idx}, ${idx - 1}, event)">◀</button>` : ''}
                        ${canRight ? `<button class="btn-shift-dash" title="Dời sang phải" onclick="moveDashTile(${idx}, ${idx + 1}, event)">▶</button>` : ''}
                    </div>
                `;
            }

            return `
                <div class="tile-dash-wrapper">
                    ${shiftControls}
                    <div class="${tileClass}">
                        <span class="tile-value">${displayVal}</span>
                    </div>
                </div>
            `;
        }).join('');

        // Render MY DRAWN TILE SLOT if I have a drawnTile currently
        if (isMyTurn && room.drawnTile) {
            myDrawnTileSlot.style.display = 'flex';
            const valStr = room.drawnTile.isJoker ? '-' : room.drawnTile.value;
            myDrawnTileCardContainer.innerHTML = `
                <div class="tile-card tile-${room.drawnTile.color}">
                    <span class="tile-value">${valStr}</span>
                </div>
            `;
        } else {
            myDrawnTileSlot.style.display = 'none';
        }
    }
}

// RENDER CENTER TABLE POOL
function renderTablePool(room) {
    if (!tablePoolTiles) return;
    if (deckBlackCount) deckBlackCount.innerText = room.blackRemaining !== undefined ? room.blackRemaining : 0;
    if (deckWhiteCount) deckWhiteCount.innerText = room.whiteRemaining !== undefined ? room.whiteRemaining : 0;

    const isMyDraftTurn = (room.state === 'initial_draft' && room.draftTurnSocketId === socket.id);
    const isMyDrawTurn = (room.state === 'in_game' && room.currentTurnSocketId === socket.id && room.turnPhase === 'drawing');
    const canClickPool = isMyDraftTurn || isMyDrawTurn;

    if (!room.tablePool || room.tablePool.length === 0) {
        tablePoolTiles.innerHTML = '<div class="empty-seat-text" style="padding: 10px;">Hết bài trên bàn</div>';
        return;
    }

    const blackTiles = room.tablePool.filter(t => t.color === 'black');
    const whiteTiles = room.tablePool.filter(t => t.color === 'white');

    const renderGroup = (tiles, colorName) => {
        if (tiles.length === 0) return `<div class="empty-seat-text" style="font-size: 0.72rem;">Hết ${colorName}</div>`;
        return tiles.map(tile => {
            const clickableClass = canClickPool ? 'clickable draw-ready' : '';
            return `
                <div class="pool-tile pool-tile-${tile.color} ${clickableClass}" data-tile-id="${tile.id}" data-color="${tile.color}" onclick="handleTableTileClick(${tile.id})" title="${canClickPool ? 'Nhấp để bốc quân ' + colorName : ''}">
                    <i class="fa-solid fa-lock pool-tile-lock"></i>
                </div>
            `;
        }).join('');
    };

    tablePoolTiles.innerHTML = `
        <div class="pool-group pool-group-black">
            <span class="pool-group-label">ĐEN (${blackTiles.length})</span>
            <div class="pool-group-tiles">${renderGroup(blackTiles, 'Đen')}</div>
        </div>
        <div class="pool-group-divider"></div>
        <div class="pool-group pool-group-white">
            <span class="pool-group-label">TRẮNG (${whiteTiles.length})</span>
            <div class="pool-group-tiles">${renderGroup(whiteTiles, 'Trắng')}</div>
        </div>
    `;
}

// TABLE POOL TILE CLICK HANDLER
window.handleTableTileClick = function(tileId) {
    if (!currentRoomState) return;
    const isMyDraftTurn = (currentRoomState.state === 'initial_draft' && currentRoomState.draftTurnSocketId === socket.id);
    const isMyDrawTurn = (currentRoomState.state === 'in_game' && currentRoomState.currentTurnSocketId === socket.id && currentRoomState.turnPhase === 'drawing');

    if (isMyDraftTurn) {
        socket.emit('draft_tile', { tileId });
        playSound('draw');
    } else if (isMyDrawTurn) {
        socket.emit('draw_tile', { tileId });
        playSound('draw');
    }
};

// DASH SHIFT HANDLER ON SELF RACK
window.moveDashTile = function(fromIndex, toIndex, event) {
    if (event) event.stopPropagation();
    socket.emit('move_dash', { fromIndex, toIndex });
    playSound('flip');
};

function renderOpponentCardInSeat(seatElement, opp, isMyTurn, room) {
    const isOppTurn = (opp.socketId === room.currentTurnSocketId);
    const cardClass = `seat-opponent-card ${isOppTurn ? 'current-turn-player' : ''} ${opp.isEliminated ? 'eliminated' : ''}`;

    const tilesHtml = opp.hand.map((tile, idx) => {
        const isRevealed = tile.isRevealed;
        const isTargetable = isMyTurn && room.state === 'in_game' && !isRevealed && !opp.isEliminated;
        const isSelected = selectedTarget && selectedTarget.targetSocketId === opp.socketId && selectedTarget.targetTileIndex === idx;

        const tileClass = `tile-card tile-${tile.color} ${isRevealed ? 'revealed' : 'face-down'} ${isTargetable ? 'targetable' : ''} ${isSelected ? 'selected-target' : ''}`;

        const displayVal = isRevealed ? (tile.isJoker ? '-' : tile.value) : '';

        return `
            <div class="${tileClass}" data-target-socket="${opp.socketId}" data-target-index="${idx}" data-color="${tile.color}" data-name="${opp.name}" onclick="handleTargetTileClick(this, event)">
                <span class="tile-value">${displayVal}</span>
            </div>
        `;
    }).join('');

    seatElement.innerHTML = `
        <div class="${cardClass}">
            <div class="opponent-header">
                <span class="opponent-name">${opp.name} ${opp.isEliminated ? '(Thua)' : ''}</span>
                <div class="coin-badge"><i class="fa-solid fa-coins"></i> ${opp.coins} Xu</div>
            </div>
            <div class="tiles-rack">
                ${tilesHtml}
            </div>
        </div>
    `;
}

function getTurnPhaseText(phase) {
    switch (phase) {
        case 'drawing': return 'bốc bài';
        case 'guessing': return 'đoán bài';
        case 'action_choice': return 'chọn hành động';
        default: return '';
    }
}

// FLOATING GUESS DOCK LOGIC
function openGuessDock(targetSocketId, targetTileIndex, color, oppName, tileEl) {
    selectedTarget = { targetSocketId, targetTileIndex, color };
    selectedGuessValue = null;

    // Highlight target on board
    document.querySelectorAll('.tile-card.selected-target').forEach(el => el.classList.remove('selected-target'));
    if (tileEl) {
        tileEl.classList.add('selected-target');
    }

    if (guessDockDesc) {
        guessDockDesc.innerHTML = `Đang đoán lá số <strong>#${targetTileIndex + 1}</strong> của <strong>${oppName}</strong>`;
    }

    if (guessDockColorBadge) {
        guessDockColorBadge.className = `target-color-badge color-${color}`;
        guessDockColorBadge.innerText = color === 'black' ? 'Thẻ Đen' : 'Thẻ Trắng';
    }

    document.querySelectorAll('.btn-num-select').forEach(b => b.classList.remove('selected'));
    if (btnConfirmGuess) btnConfirmGuess.disabled = true;

    closeModal(modalDrawnReveal);
    closeModal(modalActionChoice);

    if (guessDock) guessDock.classList.add('active');
}

function closeGuessDock() {
    if (guessDock) guessDock.classList.remove('active');
    document.querySelectorAll('.tile-card.selected-target').forEach(el => el.classList.remove('selected-target'));
    selectedTarget = null;
    selectedGuessValue = null;
}

if (btnCloseGuessDock) {
    btnCloseGuessDock.addEventListener('click', closeGuessDock);
}
if (btnCancelGuess) {
    btnCancelGuess.addEventListener('click', closeGuessDock);
}

document.querySelectorAll('.btn-num-select').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-num-select').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedGuessValue = btn.dataset.val;
        if (btnConfirmGuess) btnConfirmGuess.disabled = false;
    });
});

if (btnConfirmGuess) {
    btnConfirmGuess.addEventListener('click', () => {
        if (!selectedTarget || selectedGuessValue === null) return;

        socket.emit('make_guess', {
            targetSocketId: selectedTarget.targetSocketId,
            targetTileIndex: selectedTarget.targetTileIndex,
            guessedValue: selectedGuessValue
        });

        closeGuessDock();
    });
}

if (btnFinishPrep) {
    btnFinishPrep.addEventListener('click', () => socket.emit('finish_prep'));
}

// ACTION CHOICE MODAL
btnChoiceAgain.addEventListener('click', () => {
    socket.emit('player_action_choice', { choice: 'guess_again' });
    closeModal(modalActionChoice);
});

btnChoicePass.addEventListener('click', () => {
    socket.emit('player_action_choice', { choice: 'pass_turn' });
    closeModal(modalActionChoice);
});

// GAME OVER MODAL
function renderGameOverModal(room) {
    gameOverReason.innerText = `KẾT THÚC GAME - MẬT MÃ ĐÃ BỊ BỘC LỘ!`;
    const sorted = [...room.players].sort((a, b) => b.coins - a.coins);

    rankingList.innerHTML = sorted.map((p, idx) => `
        <div class="ranking-row ${idx === 0 ? 'rank-1' : ''}">
            <div class="rank-badge">${idx === 0 ? '🥇 HẠNG 1' : `HẠNG ${idx + 1}`}</div>
            <div><strong>${p.name}</strong> ${p.socketId === socket.id ? '(Bạn)' : ''}</div>
            <div class="coin-badge"><i class="fa-solid fa-coins"></i> ${p.coins} Xu</div>
        </div>
    `).join('');

    const isHost = (room.hostSocketId === socket.id);
    btnRestartGame.style.display = isHost ? 'inline-flex' : 'none';

    openModal(modalGameOver);
}

function openModal(modalEl) { if (modalEl) modalEl.classList.add('active'); }
function closeModal(modalEl) { if (modalEl) modalEl.classList.remove('active'); }
function closeAllModals() { [modalDrawnReveal, modalWrongGuess, modalActionChoice, modalGameOver].forEach(m => closeModal(m)); }