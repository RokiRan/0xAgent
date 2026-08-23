// ============================================
// TETRIS GAME - Main JavaScript File
// ============================================

// Constants
const COLS = 10;
const ROWS = 20;
const CELL_SIZE = 30;
const PREVIEW_CELL_SIZE = 25;
const LINES_PER_LEVEL = 10;

// Tetromino definitions with SRS rotation states
// Each piece has 4 rotation states, each as a 4x4 (or 2x2 for O) matrix
const TETROMINOES = {
    I: {
        color: '#00f5ff',
        rotations: [
            [
                [0, 0, 0, 0],
                [1, 1, 1, 1],
                [0, 0, 0, 0],
                [0, 0, 0, 0]
            ],
            [
                [0, 0, 1, 0],
                [0, 0, 1, 0],
                [0, 0, 1, 0],
                [0, 0, 1, 0]
            ],
            [
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [1, 1, 1, 1],
                [0, 0, 0, 0]
            ],
            [
                [0, 1, 0, 0],
                [0, 1, 0, 0],
                [0, 1, 0, 0],
                [0, 1, 0, 0]
            ]
        ]
    },
    O: {
        color: '#ffeb3b',
        rotations: [
            [
                [1, 1],
                [1, 1]
            ],
            [
                [1, 1],
                [1, 1]
            ],
            [
                [1, 1],
                [1, 1]
            ],
            [
                [1, 1],
                [1, 1]
            ]
        ]
    },
    T: {
        color: '#9c27b0',
        rotations: [
            [
                [0, 1, 0],
                [1, 1, 1],
                [0, 0, 0]
            ],
            [
                [0, 1, 0],
                [0, 1, 1],
                [0, 1, 0]
            ],
            [
                [0, 0, 0],
                [1, 1, 1],
                [0, 1, 0]
            ],
            [
                [0, 1, 0],
                [1, 1, 0],
                [0, 1, 0]
            ]
        ]
    },
    S: {
        color: '#00ff88',
        rotations: [
            [
                [0, 1, 1],
                [1, 1, 0],
                [0, 0, 0]
            ],
            [
                [0, 1, 0],
                [0, 1, 1],
                [0, 0, 1]
            ],
            [
                [0, 0, 0],
                [0, 1, 1],
                [1, 1, 0]
            ],
            [
                [1, 0, 0],
                [1, 1, 0],
                [0, 1, 0]
            ]
        ]
    },
    Z: {
        color: '#ff5252',
        rotations: [
            [
                [1, 1, 0],
                [0, 1, 1],
                [0, 0, 0]
            ],
            [
                [0, 0, 1],
                [0, 1, 1],
                [0, 1, 0]
            ],
            [
                [0, 0, 0],
                [1, 1, 0],
                [0, 1, 1]
            ],
            [
                [0, 1, 0],
                [1, 1, 0],
                [1, 0, 0]
            ]
        ]
    },
    J: {
        color: '#2196f3',
        rotations: [
            [
                [1, 0, 0],
                [1, 1, 1],
                [0, 0, 0]
            ],
            [
                [0, 1, 1],
                [0, 1, 0],
                [0, 1, 0]
            ],
            [
                [0, 0, 0],
                [1, 1, 1],
                [0, 0, 1]
            ],
            [
                [0, 1, 0],
                [0, 1, 0],
                [1, 1, 0]
            ]
        ]
    },
    L: {
        color: '#ff9800',
        rotations: [
            [
                [0, 0, 1],
                [1, 1, 1],
                [0, 0, 0]
            ],
            [
                [0, 1, 0],
                [0, 1, 0],
                [0, 1, 1]
            ],
            [
                [0, 0, 0],
                [1, 1, 1],
                [1, 0, 0]
            ],
            [
                [1, 1, 0],
                [0, 1, 0],
                [0, 1, 0]
            ]
        ]
    }
};

const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// Scoring system
const LINE_SCORES = [0, 100, 300, 500, 800];

// Game state
let board = [];
let currentPiece = null;
let nextPiece = null;
let score = 0;
let level = 1;
let lines = 0;
let gameOver = false;
let paused = false;
let started = false;
let dropCounter = 0;
let dropInterval = 1000;
let lastTime = 0;
let animationId = null;
let lineClearAnimation = null;
let clearingRows = [];

// Canvas elements
const canvas = document.getElementById('game-board');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next-piece');
const nextCtx = nextCanvas.getContext('2d');

// Display elements
const scoreEl = document.getElementById('score');
const levelEl = document.getElementById('level');
const linesEl = document.getElementById('lines');
const overlay = document.getElementById('game-overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayMessage = document.getElementById('overlay-message');
const overlayButton = document.getElementById('overlay-button');

// ============================================
// Board Management
// ============================================
function createBoard() {
    board = [];
    for (let r = 0; r < ROWS; r++) {
        board.push(new Array(COLS).fill(null));
    }
}

function resetGame() {
    createBoard();
    score = 0;
    level = 1;
    lines = 0;
    gameOver = false;
    paused = false;
    dropCounter = 0;
    dropInterval = 1000;
    clearingRows = [];
    lineClearAnimation = null;
    nextPiece = randomPiece();
    spawnPiece();
    updateUI();
    hideOverlay();
}

function randomPiece() {
    const type = PIECE_TYPES[Math.floor(Math.random() * PIECE_TYPES.length)];
    return {
        type: type,
        rotation: 0,
        x: Math.floor(COLS / 2) - 2,
        y: type === 'I' ? -1 : 0
    };
}

function spawnPiece() {
    currentPiece = nextPiece;
    nextPiece = randomPiece();
    // Reset position based on piece type
    currentPiece.x = Math.floor(COLS / 2) - Math.ceil(TETROMINOES[currentPiece.type].rotations[0][0].length / 2);
    currentPiece.y = currentPiece.type === 'I' ? -1 : 0;
    currentPiece.rotation = 0;

    // Check for game over
    if (collides(currentPiece, 0, 0)) {
        gameOver = true;
        showGameOver();
    }
    drawNextPiece();
}

// ============================================
// Collision Detection
// ============================================
function getMatrix(piece) {
    return TETROMINOES[piece.type].rotations[piece.rotation];
}

function collides(piece, offsetX, offsetY, rotation = piece.rotation) {
    const matrix = TETROMINOES[piece.type].rotations[rotation];
    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                const newX = piece.x + c + offsetX;
                const newY = piece.y + r + offsetY;
                if (newX < 0 || newX >= COLS || newY >= ROWS) {
                    return true;
                }
                if (newY >= 0 && board[newY][newX]) {
                    return true;
                }
            }
        }
    }
    return false;
}

// ============================================
// Piece Movement
// ============================================
function movePiece(dx, dy) {
    if (gameOver || paused || lineClearAnimation) return false;
    if (!collides(currentPiece, dx, dy)) {
        currentPiece.x += dx;
        currentPiece.y += dy;
        return true;
    }
    return false;
}

function rotatePiece() {
    if (gameOver || paused || lineClearAnimation) return;
    const newRotation = (currentPiece.rotation + 1) % 4;
    // Try basic wall kicks
    const kicks = [0, -1, 1, -2, 2];
    for (const kick of kicks) {
        if (!collides(currentPiece, kick, 0, newRotation)) {
            currentPiece.x += kick;
            currentPiece.rotation = newRotation;
            return;
        }
    }
}

function hardDrop() {
    if (gameOver || paused || lineClearAnimation) return;
    let dropDistance = 0;
    while (!collides(currentPiece, 0, 1)) {
        currentPiece.y++;
        dropDistance++;
    }
    score += dropDistance * 2;
    lockPiece();
}

// ============================================
// Piece Locking & Line Clearing
// ============================================
function lockPiece() {
    const matrix = getMatrix(currentPiece);
    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                const boardY = currentPiece.y + r;
                const boardX = currentPiece.x + c;
                if (boardY >= 0 && boardY < ROWS && boardX >= 0 && boardX < COLS) {
                    board[boardY][boardX] = TETROMINOES[currentPiece.type].color;
                }
            }
        }
    }
    checkLineClear();
    if (!lineClearAnimation) {
        spawnPiece();
    }
}

function checkLineClear() {
    clearingRows = [];
    for (let r = ROWS - 1; r >= 0; r--) {
        let full = true;
        for (let c = 0; c < COLS; c++) {
            if (!board[r][c]) {
                full = false;
                break;
            }
        }
        if (full) {
            clearingRows.push(r);
        }
    }

    if (clearingRows.length > 0) {
        lineClearAnimation = {
            rows: [...clearingRows],
            startTime: performance.now(),
            duration: 300
        };
        // Calculate score
        const lineCount = clearingRows.length;
        score += LINE_SCORES[lineCount] * level;
        lines += lineCount;

        // Level up check
        const newLevel = Math.floor(lines / LINES_PER_LEVEL) + 1;
        if (newLevel > level) {
            level = newLevel;
            // Increase drop speed (capped at minimum)
            dropInterval = Math.max(50, 1000 - (level - 1) * 80);
        }
        updateUI();
    }
}

function completeLineClear() {
    // Remove cleared rows from bottom to top
    clearingRows.sort((a, b) => b - a);
    for (const row of clearingRows) {
        board.splice(row, 1);
        board.unshift(new Array(COLS).fill(null));
    }
    clearingRows = [];
    lineClearAnimation = null;
    spawnPiece();
}

// ============================================
// Drawing Functions
// ============================================
function drawCell(ctx, x, y, color, size = CELL_SIZE) {
    const padding = 1;
    // Main block
    ctx.fillStyle = color;
    ctx.fillRect(x * size + padding, y * size + padding, size - padding * 2, size - padding * 2);

    // Highlight (top/left)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillRect(x * size + padding, y * size + padding, size - padding * 2, 3);
    ctx.fillRect(x * size + padding, y * size + padding, 3, size - padding * 2);

    // Shadow (bottom/right)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(x * size + padding, y * size + size - padding - 3, size - padding * 2, 3);
    ctx.fillRect(x * size + size - padding - 3, y * size + padding, 3, size - padding * 2);

    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x * size + padding, y * size + padding, size - padding * 2, size - padding * 2);
    ctx.shadowBlur = 0;
}

function drawGrid() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL_SIZE, 0);
        ctx.lineTo(x * CELL_SIZE, ROWS * CELL_SIZE);
        ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL_SIZE);
        ctx.lineTo(COLS * CELL_SIZE, y * CELL_SIZE);
        ctx.stroke();
    }
}

function drawBoard() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();

    // Draw placed pieces
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (board[r][c]) {
                if (clearingRows.includes(r)) {
                    // Animation effect for clearing lines
                    const elapsed = performance.now() - lineClearAnimation.startTime;
                    const progress = elapsed / lineClearAnimation.duration;
                    const alpha = 1 - progress;
                    ctx.globalAlpha = alpha;
                    drawCell(ctx, c, r, '#ffffff');
                    ctx.globalAlpha = 1;
                } else {
                    drawCell(ctx, c, r, board[r][c]);
                }
            }
        }
    }
}

function drawPiece(piece, context, canvas, cellSize, offsetX = 0, offsetY = 0) {
    if (!piece) return;
    const matrix = TETROMINOES[piece.type].rotations[piece.rotation];
    const color = TETROMINOES[piece.type].color;

    // Calculate bounds to center the piece
    let minX = matrix[0].length, maxX = -1, minY = matrix.length, maxY = -1;
    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                minX = Math.min(minX, c);
                maxX = Math.max(maxX, c);
                minY = Math.min(minY, r);
                maxY = Math.max(maxY, r);
            }
        }
    }

    const pieceWidth = (maxX - minX + 1) * cellSize;
    const pieceHeight = (maxY - minY + 1) * cellSize;
    const startX = offsetX + (canvas.width - pieceWidth) / 2 - minX * cellSize;
    const startY = offsetY + (canvas.height - pieceHeight) / 2 - minY * cellSize;

    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                const padding = 1;
                const x = startX + c * cellSize;
                const y = startY + r * cellSize;

                context.fillStyle = color;
                context.fillRect(x + padding, y + padding, cellSize - padding * 2, cellSize - padding * 2);

                context.fillStyle = 'rgba(255, 255, 255, 0.4)';
                context.fillRect(x + padding, y + padding, cellSize - padding * 2, 3);
                context.fillRect(x + padding, y + padding, 3, cellSize - padding * 2);

                context.fillStyle = 'rgba(0, 0, 0, 0.3)';
                context.fillRect(x + padding, y + cellSize - padding - 3, cellSize - padding * 2, 3);
                context.fillRect(x + cellSize - padding - 3, y + padding, 3, cellSize - padding * 2);
            }
        }
    }
}

function drawCurrentPiece() {
    if (!currentPiece || gameOver) return;
    const matrix = getMatrix(currentPiece);
    const color = TETROMINOES[currentPiece.type].color;

    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                const x = currentPiece.x + c;
                const y = currentPiece.y + r;
                if (y >= 0) {
                    drawCell(ctx, x, y, color);
                }
            }
        }
    }

    // Draw ghost piece (preview of where it will land)
    drawGhostPiece();
}

function drawGhostPiece() {
    if (!currentPiece || gameOver || lineClearAnimation) return;
    let ghostY = currentPiece.y;
    while (!collides({...currentPiece, y: ghostY}, 0, 1)) {
        ghostY++;
    }

    const matrix = getMatrix(currentPiece);
    const color = TETROMINOES[currentPiece.type].color;

    for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
            if (matrix[r][c]) {
                const x = currentPiece.x + c;
                const y = ghostY + r;
                if (y >= 0) {
                    ctx.fillStyle = color + '40'; // 25% opacity
                    ctx.fillRect(x * CELL_SIZE + 2, y * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
                    ctx.strokeStyle = color + '80';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(x * CELL_SIZE + 2, y * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
                }
            }
        }
    }
}

function drawNextPiece() {
    nextCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
    if (nextPiece) {
        drawPiece(nextPiece, nextCtx, nextCanvas, PREVIEW_CELL_SIZE);
    }
}

function draw() {
    drawBoard();
    drawCurrentPiece();
}

// ============================================
// UI Updates
// ============================================
function updateUI() {
    scoreEl.textContent = score;
    levelEl.textContent = level;
    linesEl.textContent = lines;
}

function showOverlay(title, message, buttonText) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    overlayButton.textContent = buttonText;
    overlay.classList.remove('hidden');
}

function hideOverlay() {
    overlay.classList.add('hidden');
}

function showGameOver() {
    showOverlay('GAME OVER', `Final Score: ${score}`, 'PLAY AGAIN');
}

function showPause() {
    showOverlay('PAUSED', 'Press P to resume', 'RESUME');
}

function showStart() {
    showOverlay('TETRIS', 'Press START or any key', 'START');
}

// ============================================
// Game Loop
// ============================================
function gameLoop(time = 0) {
    if (gameOver) {
        animationId = null;
        return;
    }

    const deltaTime = time - lastTime;
    lastTime = time;

    if (!paused) {
        // Handle line clear animation
        if (lineClearAnimation) {
            const elapsed = performance.now() - lineClearAnimation.startTime;
            if (elapsed >= lineClearAnimation.duration) {
                completeLineClear();
            }
        } else if (currentPiece) {
            dropCounter += deltaTime;
            if (dropCounter > dropInterval) {
                if (!movePiece(0, 1)) {
                    lockPiece();
                }
                dropCounter = 0;
            }
        }

        draw();
    }

    animationId = requestAnimationFrame(gameLoop);
}

// ============================================
// Input Handling
// ============================================
function startGame() {
    if (!started) {
        started = true;
        resetGame();
        lastTime = performance.now();
        animationId = requestAnimationFrame(gameLoop);
    } else if (gameOver) {
        cancelAnimationFrame(animationId);
        animationId = null;
        resetGame();
        lastTime = performance.now();
        animationId = requestAnimationFrame(gameLoop);
    } else if (paused) {
        paused = false;
        hideOverlay();
    }
}

function togglePause() {
    if (gameOver || !started) return;
    paused = !paused;
    if (paused) {
        showPause();
    } else {
        hideOverlay();
        lastTime = performance.now();
    }
}

document.addEventListener('keydown', (e) => {
    if (!started) {
        startGame();
        return;
    }

    if (gameOver) {
        if (e.key === 'r' || e.key === 'R') {
            startGame();
        }
        return;
    }

    switch (e.key) {
        case 'ArrowLeft':
            e.preventDefault();
            movePiece(-1, 0);
            break;
        case 'ArrowRight':
            e.preventDefault();
            movePiece(1, 0);
            break;
        case 'ArrowDown':
            e.preventDefault();
            if (movePiece(0, 1)) {
                score += 1;
                updateUI();
            }
            break;
        case 'ArrowUp':
            e.preventDefault();
            rotatePiece();
            break;
        case ' ':
            e.preventDefault();
            hardDrop();
            updateUI();
            break;
        case 'p':
        case 'P':
            togglePause();
            break;
        case 'r':
        case 'R':
            cancelAnimationFrame(animationId);
            animationId = null;
            resetGame();
            lastTime = performance.now();
            animationId = requestAnimationFrame(gameLoop);
            break;
    }
});

overlayButton.addEventListener('click', startGame);

// Initialize game on load
window.addEventListener('load', () => {
    createBoard();
    nextPiece = randomPiece();
    // Draw initial empty board
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawNextPiece();
    showStart();
});
