export class AppError extends Error {
  constructor(public message: string, public status = 400, public code = 'invalid_input') { super(message); }
}
export function publicError(error: unknown) {
  if (error instanceof AppError) return { message:error.message, code:error.code, status:error.status };
  return {message:'Cette opération a échoué. Réessaie ou consulte les connexions.',code:'operation_failed',status:500};
}
