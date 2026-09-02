const state = {
  constructorOptions: [],
  commandCalls: 0,
};

function denyCommand() {
  state.commandCalls += 1;
  throw new Error("No-network Upstash fake forbids Redis commands.");
}

export const NO_NETWORK_UPSTASH_FAKE = true;

export function getNoNetworkUpstashFakeState() {
  return {
    constructorOptions: state.constructorOptions.map((entry) => ({ ...entry })),
    commandCalls: state.commandCalls,
  };
}

export class Redis {
  constructor(options) {
    state.constructorOptions.push({
      hasUrl: typeof options?.url === "string" && options.url.length > 0,
      hasToken: typeof options?.token === "string" && options.token.length > 0,
      retry: options?.retry,
      hasSignal: typeof options?.signal === "function",
    });
  }

  get() {
    return denyCommand();
  }

  set() {
    return denyCommand();
  }

  del() {
    return denyCommand();
  }

  sadd() {
    return denyCommand();
  }

  srem() {
    return denyCommand();
  }

  smembers() {
    return denyCommand();
  }

  keys() {
    return denyCommand();
  }

  eval() {
    return denyCommand();
  }

  pipeline() {
    return denyCommand();
  }
}
