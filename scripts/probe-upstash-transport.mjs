import { lookup } from "node:dns";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

const CONFIRMATION_ARGUMENT = "--confirm-fixed-transport";
const FIXED_TIMEOUT_MS = 10_000;
const URL_ENVIRONMENT_NAME = "UPSTASH_REDIS_REST_URL";
const EXIT_CODES = Object.freeze({
  PASS_TRANSPORT_TLS: 0,
  STOP_TRANSPORT_DNS: 40,
  STOP_TRANSPORT_TCP: 41,
  STOP_TRANSPORT_TLS: 42,
  STOP_TRANSPORT_TIMEOUT: 43,
  STOP_TRANSPORT_INDETERMINATE: 44,
});

function parseFixedUrl() {
  const value = process.env[URL_ENVIRONMENT_NAME];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.toUpperCase().includes(`${URL_ENVIRONMENT_NAME}=`)
  ) {
    return null;
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    parsed.hostname.length === 0
  ) {
    return null;
  }
  return parsed.hostname;
}

function runFixedTransport(hostname) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let tcpConnected = false;

    const finish = (candidate) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let classification = candidate;
      if (socket !== null) {
        try {
          socket.destroy();
        } catch {
          classification = "STOP_TRANSPORT_INDETERMINATE";
        }
      }
      resolve(classification);
    };

    const timer = setTimeout(() => {
      finish("STOP_TRANSPORT_TIMEOUT");
    }, FIXED_TIMEOUT_MS);

    try {
      lookup(
        hostname,
        { all: false, verbatim: true },
        (error, address, family) => {
          if (settled) return;
          if (error !== null) {
            finish("STOP_TRANSPORT_DNS");
            return;
          }
          if (
            typeof address !== "string" ||
            (family !== 4 && family !== 6) ||
            isIP(address) !== family
          ) {
            finish("STOP_TRANSPORT_INDETERMINATE");
            return;
          }

          try {
            socket = connectTls({
              host: address,
              port: 443,
              servername: hostname,
              rejectUnauthorized: true,
              lookup() {
                throw new Error();
              },
            });
          } catch {
            finish("STOP_TRANSPORT_INDETERMINATE");
            return;
          }

          try {
            if (
              socket === null ||
              typeof socket.once !== "function" ||
              typeof socket.destroy !== "function"
            ) {
              finish("STOP_TRANSPORT_INDETERMINATE");
              return;
            }
            socket.once("connect", () => {
              if (!settled) tcpConnected = true;
            });
            socket.once("secureConnect", () => {
              finish("PASS_TRANSPORT_TLS");
            });
            socket.once("error", () => {
              finish(
                tcpConnected ? "STOP_TRANSPORT_TLS" : "STOP_TRANSPORT_TCP"
              );
            });
            socket.once("close", () => {
              if (!settled) {
                finish(
                  tcpConnected ? "STOP_TRANSPORT_TLS" : "STOP_TRANSPORT_TCP"
                );
              }
            });
          } catch {
            finish("STOP_TRANSPORT_INDETERMINATE");
          }
        }
      );
    } catch {
      finish("STOP_TRANSPORT_INDETERMINATE");
    }
  });
}

async function classify() {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== CONFIRMATION_ARGUMENT
  ) {
    return "STOP_TRANSPORT_INDETERMINATE";
  }
  const hostname = parseFixedUrl();
  if (hostname === null) return "STOP_TRANSPORT_INDETERMINATE";
  return runFixedTransport(hostname);
}

let classification = "STOP_TRANSPORT_INDETERMINATE";
try {
  const candidate = await classify();
  classification = Object.hasOwn(EXIT_CODES, candidate)
    ? candidate
    : "STOP_TRANSPORT_INDETERMINATE";
} catch {
  classification = "STOP_TRANSPORT_INDETERMINATE";
}

process.exitCode = EXIT_CODES[classification];
process.stdout.write(`${classification}\n`);
