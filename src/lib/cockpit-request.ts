import type { ApiError } from './ui-contract';

export class CockpitRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export type CockpitRequestInit = RequestInit & { timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 30_000;

export async function request<T>(path: string, init?: CockpitRequestInit): Promise<T> {
  const { timeoutMs, signal: userSignal, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const delay = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0 ? timeoutMs as number : DEFAULT_TIMEOUT_MS;
  let timedOut = false;

  const abortFromUser = () => controller.abort(userSignal?.reason);
  if (userSignal?.aborted) abortFromUser();
  else userSignal?.addEventListener('abort', abortFromUser, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, delay);

  let response: Response;
  try {
    try {
      response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...fetchInit, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...init?.headers } });
    } catch (error) {
      if (userSignal?.aborted) throw error;
      if (timedOut) throw new CockpitRequestError('La lecture a pris trop de temps. Réessaie dans un instant.', 0);
      throw new CockpitRequestError('La connexion a été interrompue. Réessaie la lecture.', 0);
    }
    if (!response.ok) {
      let body: ApiError | null = null;
      try {
        body = await response.json() as ApiError;
      } catch (error) {
        if (userSignal?.aborted) throw error;
        if (timedOut) throw new CockpitRequestError('La lecture a pris trop de temps. Réessaie dans un instant.', 0);
      }
      const message = response.status === 401 ? 'Ta session a expiré. Reconnecte-toi pour continuer.' : body?.error ?? 'La lecture n’a pas abouti. Réessaie dans un instant.';
      throw new CockpitRequestError(message, response.status);
    }
    try {
      return await response.json() as T;
    } catch (error) {
      if (userSignal?.aborted) throw error;
      if (timedOut) throw new CockpitRequestError('La lecture a pris trop de temps. Réessaie dans un instant.', 0);
      throw new CockpitRequestError('La réponse du serveur est illisible. Réessaie dans un instant.', response.status);
    }
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', abortFromUser);
  }
}
