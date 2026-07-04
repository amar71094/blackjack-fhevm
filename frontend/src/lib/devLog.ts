const isDev = import.meta.env.DEV;

export const devLog = (...args: unknown[]) => {
  if (isDev) console.info(...args);
};

export const devWarn = (...args: unknown[]) => {
  if (isDev) console.warn(...args);
};

export const devError = (...args: unknown[]) => {
  if (isDev) console.error(...args);
};

export const devDebug = (...args: unknown[]) => {
  if (isDev) console.debug(...args);
};