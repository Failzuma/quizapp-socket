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
    cleanupTimeout?: NodeJS.Timeout;
}

const activeSessions: Record<string, Session> = {};

const generateRoomCode = (): string => {
    let code = '';
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const isCodeInUse = Object.values(activeSessions).some(session => session.roomCode === code);
    if (isCodeInUse) {
        return generateRoomCode();
    }
    return code;
};

const httpServer = createServer();

const io = new Server(httpServer, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    socket.on('request_session', ({ quizId, playerInfo }) => {
        let session = activeSessions[quizId];

        if (!session) {
            session = {
                roomCode: generateRoomCode(),
                players: {},
            };
            activeSessions[quizId] = session;
            console.log(`[Sesi] Sesi baru dibuat untuk Kuis ID ${quizId} dengan kode ${session.roomCode}`);
        }

        if (session.cleanupTimeout) {
            clearTimeout(session.cleanupTimeout);
            delete session.cleanupTimeout;
            console.log(`[Sesi] Sesi untuk Kuis ID ${quizId} diaktifkan kembali.`);
        }

        socket.join(session.roomCode);
        session.players[socket.id] = playerInfo;

        socket.emit('session_ready', {
            quizId,
            roomCode: session.roomCode,
            players: session.players,
            ownSocketId: socket.id
        });

        socket.to(session.roomCode).emit('new_player', {
            playerId: socket.id,
            playerInfo: session.players[socket.id]
        });
    });

    socket.on('player_movement', ({ roomCode, x, y }) => {
        const session = Object.values(activeSessions).find(s => s.roomCode === roomCode);
        if (session?.players[socket.id]) {
            session.players[socket.id].x = x;
            session.players[socket.id].y = y;
            socket.to(roomCode).emit('player_moved', { playerId: socket.id, x, y });
        }
    });

    socket.on('disconnect', () => {
        let quizIdToClean: string | null = null;
        let roomCodeToNotify: string | null = null;

        for (const quizId in activeSessions) {
            const session = activeSessions[quizId];
            if (session.players[socket.id]) {
                roomCodeToNotify = session.roomCode;
                delete session.players[socket.id];
                socket.to(roomCodeToNotify).emit('player_disconnected', socket.id);
                
                if (Object.keys(session.players).length === 0) {
                    quizIdToClean = quizId;
                }
                break;
            }
        }

        if (quizIdToClean) {
            const session = activeSessions[quizIdToClean];
            console.log(`[Sesi] Sesi untuk Kuis ID ${quizIdToClean} kosong. Memulai timer pembersihan...`);
            session.cleanupTimeout = setTimeout(() => {
                delete activeSessions[quizIdToClean!];
                console.log(`[Sesi] Sesi untuk Kuis ID ${quizIdToClean} telah dihapus.`);
            }, 60000);
        }
    });
});

httpServer.listen(port, () => {
    console.log(`> Server WebSocket berjalan di port ${port}`);
});
