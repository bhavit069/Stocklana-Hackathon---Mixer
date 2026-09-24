const { Server } = require("socket.io");

let io;

function initSocket(server) {

    io = new Server(server);

    io.on("connection", async (socket) => {
        console.log("🔌 Client connected:", socket.id);

        socket.on("disconnect", () => {
        console.log("❌ Client disconnected:", socket.id);
        });
    });

    return io;
}

function getIO() {
    if (!io) throw new Error("Socket.io not initialized");
    return io;
}

module.exports = { initSocket, getIO };
