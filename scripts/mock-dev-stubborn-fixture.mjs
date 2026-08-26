import net from "node:net";

process.on("message", (message) => {
  if (message?.type === "shutdown") {
    // lifecycle test用: 通常終了要求を意図的に無視し、所有PID回収を通す。
  }
});

const server = net.createServer((socket) => socket.end());
server.listen(3000, "127.0.0.1");
