
import { createServer } from 'http';
import { Server } from 'socket.io';
import fetch from 'node-fetch';

const port = process.env.PORT || 3001;
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://quizapp-socket-production.up.railway.app';


interface PlayerData {
    x: number;
    y: number;
    character: string;
    username: string;
    score: number;
    user_id: number;
}

interface Session {
    roomCode: string;
    quizId: string;
    players: {
        [playerId: string]: PlayerData;
    };
    adminToken?: string;
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
    socket.on('request_session', ({ quizId, playerInfo, token }) => {
        let session = activeSessions[quizId];

        if (!session) {
            session = {
                roomCode: generateRoomCode(),
                quizId: quizId,
                players: {},
                adminToken: playerInfo.role === 'admin' ? token : undefined,
            };
            activeSessions[quizId] = session;
        }

        if (session.cleanupTimeout) {
            clearTimeout(session.cleanupTimeout);
            delete session.cleanupTimeout;
        }

        socket.join(session.roomCode);
        session.players[socket.id] = { ...playerInfo, score: 0 };

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
        
        io.to(session.roomCode).emit('leaderboard_update', Object.values(session.players));
    });

    socket.on('player_movement', ({ roomCode, x, y }) => {
        const session = Object.values(activeSessions).find(s => s.roomCode === roomCode);
        if (session?.players[socket.id]) {
            session.players[socket.id].x = x;
            session.players[socket.id].y = y;
            socket.to(roomCode).emit('player_moved', { playerId: socket.id, x, y });
        }
    });

    socket.on('update_score', ({ roomCode, score }) => {
        const session = Object.values(activeSessions).find(s => s.roomCode === roomCode);
        if (session?.players[socket.id]) {
            session.players[socket.id].score = score;
            io.to(roomCode).emit('leaderboard_update', Object.values(session.players));
        }
    });

    socket.on('admin_end_quiz', async ({ roomCode, token }) => {
        const session = Object.values(activeSessions).find(s => s.roomCode === roomCode);

        if (session && session.adminToken === token) {
            const leaderboard = Object.values(session.players);

            try {
                const response = await fetch(`${API_BASE_URL}/quizzes/results`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        quizId: session.quizId,
                        leaderboard: leaderboard
                    })
                });

                if (response.ok) {
                    io.to(roomCode).emit('quiz_ended', { message: 'Quiz has been ended by the admin.' });
                    delete activeSessions[session.quizId];
                } else {
                    const errorData = await response.json();
                    socket.emit('error_ending_quiz', { message: 'Failed to save results.', details: errorData });
                }
            } catch (error) {
                console.error('Error saving quiz results:', error);
                socket.emit('error_ending_quiz', { message: 'Server error while trying to end quiz.' });
            }
        } else {
            socket.emit('error_ending_quiz', { message: 'Unauthorized or invalid session.' });
        }
    });

    socket.on('disconnect', () => {
        let quizIdToClean: string | null = null;
        let roomCodeToNotify: string | null = null;

        for (const quizId in activeSessions) {
            const session = activeSessions[quizId];
            if (session.players[socket.id]) {
                roomCodeToNotify = session.roomCode;
                // If the disconnecting player was the admin, nullify the admin token
                if (session.adminToken && session.players[socket.id].role === 'admin') {
                    session.adminToken = undefined; 
                }

                delete session.players[socket.id];
                io.to(roomCodeToNotify).emit('player_disconnected', socket.id);
                
                if (Object.keys(session.players).length === 0) {
                    quizIdToClean = quizId;
                } else {
                    io.to(roomCodeToNotify).emit('leaderboard_update', Object.values(session.players));
                }
                break;
            }
        }

        if (quizIdToClean) {
            const session = activeSessions[quizIdToClean];
            session.cleanupTimeout = setTimeout(() => {
                delete activeSessions[quizIdToClean!];
            }, 60000); // 1 minute cleanup delay
        }
    });
});

httpServer.listen(port, () => {
    console.log(`> Server WebSocket berjalan di port ${port}`);
});
