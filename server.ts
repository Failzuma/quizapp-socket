import { createServer } from 'http';
import { Server } from 'socket.io';

const port = process.env.PORT || 3001;

interface PlayerData {
    x: number;
    y: number;
    character: string;
    username: string;
}

interface Session {
    roomCode: string;
    players: {
        [playerId: string]: PlayerData;
    };
    quizId: string;
    cleanupTimeout?: NodeJS.Timeout;
}

const activeSessionsByQuizId: { [quizId: string]: Session } = {};
const activeSessionsByRoomCode: { [roomCode: string]: Session } = {};

const generateRoomCode = (): string => {
    let code = '';
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return activeSessionsByRoomCode[code] ? generateRoomCode() : code;
};

const httpServer = createServer();

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
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
        }

        if (session.cleanupTimeout) {
            clearTimeout(session.cleanupTimeout);
            delete session.cleanupTimeout;
        }

        socket.emit('session_created', { roomCode: session.roomCode });
    });

    socket.on('join_game', ({ roomCode, playerInfo }) => {
        const session = activeSessionsByRoomCode[roomCode];
        if (!session) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        socket.join(roomCode);
        session.players[socket.id] = playerInfo;

        socket.emit('session_joined', {
            players: session.players,
            ownSocketId: socket.id
        });

        socket.to(roomCode).emit('new_player', {
            playerId: socket.id,
            playerInfo: session.players[socket.id]
        });
    });

    socket.on('player_movement', ({ roomCode, x, y }) => {
        const session = activeSessionsByRoomCode[roomCode];
        if (session?.players[socket.id]) {
            session.players[socket.id].x = x;
            session.players[socket.id].y = y;
            socket.to(roomCode).emit('player_moved', { playerId: socket.id, x, y });
        }
    });

    socket.on('disconnect', () => {
        let sessionToUpdate: Session | null = null;

        for (const roomCode in activeSessionsByRoomCode) {
            const session = activeSessionsByRoomCode[roomCode];
            if (session.players[socket.id]) {
                sessionToUpdate = session;
                delete session.players[socket.id];
                io.to(roomCode).emit('player_disconnected', socket.id);

                if (Object.keys(session.players).length === 0) {
                    session.cleanupTimeout = setTimeout(() => {
                        delete activeSessionsByQuizId[session.quizId];
                        delete activeSessionsByRoomCode[session.roomCode];
                    }, 60000);
                }
                break;
            }
        }
    });
});

httpServer.listen(port, () => {
    console.log(`> Server WebSocket berjalan di port ${port}`);
});
