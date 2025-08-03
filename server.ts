import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';

const port = process.env.PORT || 3001;

interface PlayerData {
    x: number;
    y: number;
    character: string;
    username: string;
}

interface Session {
    roomCode: string;
    players: { [playerId: string]: PlayerData };
    quizId: string;
    cleanupTimeout?: NodeJS.Timeout;
}

const activeSessionsByQuizId: { [quizId: string]: Session } = {};
const activeSessionsByRoomCode: { [roomCode: string]: Session } = {};

// === Rotating log system ===
function getLogFilePath() {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(__dirname, `logs/server-${dateStr}.log`);
}

function log(message: string) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);

    const logPath = getLogFilePath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, logLine + '\n');
}

// === Room code generator ===
function generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return activeSessionsByRoomCode[code] ? generateRoomCode() : code;
}

const httpServer = createServer();

const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    log(`[+] New connection: ${socket.id} from ${ip}`);

    socket.on('request_session', (quizId: string) => {
        let session = activeSessionsByQuizId[quizId];

        if (!session) {
            const roomCode = generateRoomCode();
            session = {
                quizId,
                roomCode,
                players: {},
            };
            activeSessionsByQuizId[quizId] = session;
            activeSessionsByRoomCode[roomCode] = session;
            log(`[+] Created new session: quiz=${quizId}, room=${roomCode}`);
        } else {
            log(`[=] Reusing existing session: quiz=${quizId}, room=${session.roomCode}`);
        }

        if (session.cleanupTimeout) {
            clearTimeout(session.cleanupTimeout);
            delete session.cleanupTimeout;
            log(`[~] Cancelled cleanup timeout for room ${session.roomCode}`);
        }

        socket.emit('session_created', { roomCode: session.roomCode });
    });

    socket.on('join_game', ({ roomCode, playerInfo }) => {
        const session = activeSessionsByRoomCode[roomCode];
        if (!session) {
            log(`[!] Failed join: Room ${roomCode} not found`);
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        socket.join(roomCode);
        session.players[socket.id] = playerInfo;

        log(`[+] ${playerInfo.username} (${socket.id}) joined room ${roomCode}`);

        socket.emit('session_joined', {
            players: session.players,
            ownSocketId: socket.id
        });

        socket.to(roomCode).emit('new_player', {
            playerId: socket.id,
            playerInfo: playerInfo
        });
    });

    socket.on('player_movement', ({ roomCode, x, y }) => {
        const session = activeSessionsByRoomCode[roomCode];
        if (session?.players[socket.id]) {
            session.players[socket.id].x = x;
            session.players[socket.id].y = y;

            log(`[~] Move: ${socket.id} (${session.players[socket.id].username}) @ ${roomCode} => (${x}, ${y})`);

            socket.to(roomCode).emit('player_moved', {
                playerId: socket.id,
                x,
                y
            });
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in activeSessionsByRoomCode) {
            const session = activeSessionsByRoomCode[roomCode];
            if (session.players[socket.id]) {
                const username = session.players[socket.id].username;
                delete session.players[socket.id];

                log(`[-] Disconnected: ${socket.id} (${username}) from room ${roomCode}`);
                io.to(roomCode).emit('player_disconnected', socket.id);

                if (Object.keys(session.players).length === 0) {
                    session.cleanupTimeout = setTimeout(() => {
                        delete activeSessionsByQuizId[session.quizId];
                        delete activeSessionsByRoomCode[session.roomCode];
                        log(`[x] Session cleaned up: room ${roomCode}, quiz ${session.quizId}`);
                    }, 60000);
                    log(`[~] Room ${roomCode} empty. Cleanup in 60s.`);
                }
                break;
            }
        }
    });
});

httpServer.listen(port, () => {
    log(`🚀 Server WebSocket running on port ${port}`);
});
