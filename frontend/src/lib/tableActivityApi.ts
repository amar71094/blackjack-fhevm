import type { TableActivityHand } from '@/lib/tableActivityStore';

const DEFAULT_ACTIVITY_BASE = 'http://127.0.0.1:4001';

export const getTableActivityBaseUrl = (): string | null => {
  const configured = import.meta.env.VITE_ORACLE_ACTIVITY_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (import.meta.env.DEV) return DEFAULT_ACTIVITY_BASE;
  return null;
};

export interface TableActivityResponse {
  tableId: number;
  limit: number;
  activity: TableActivityHand[];
}

export const fetchTableActivity = async (
  tableId: bigint | number,
  limit = 100
): Promise<TableActivityHand[]> => {
  const baseUrl = getTableActivityBaseUrl();
  if (!baseUrl) return [];

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(
      `${baseUrl}/tables/${String(tableId)}/activity?limit=${limit}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`Activity API responded with ${response.status}`);
    }

    const payload = (await response.json()) as TableActivityResponse;
    return Array.isArray(payload.activity) ? payload.activity : [];
  } finally {
    window.clearTimeout(timeout);
  }
};