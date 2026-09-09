import type { ApiError } from './ui-contract';

export class CockpitRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new CockpitRequestError('La connexion a été interrompue. Réessaie la lecture.', 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiError | null;
    const message = response.status === 401 ? 'Ta session a expiré. Reconnecte-toi pour continuer.' : body?.error ?? 'La lecture n’a pas abouti. Réessaie dans un instant.';
    throw new CockpitRequestError(message, response.status);
  }
  return await response.json() as T;
}
