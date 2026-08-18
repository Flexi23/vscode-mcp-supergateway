export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Set it explicitly in docker-compose.yml and in the active .env file.`);
  }
  return value;
}

export function requirePort(name: string): number {
  const rawValue = requireEnv(name);
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port for ${name}: ${rawValue}. It must be an integer between 1 and 65535.`);
  }
  return parsed;
}
