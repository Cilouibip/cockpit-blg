import { ZodError } from 'zod';
import { AppError, publicError } from './errors';
export function json(body:unknown,status=200,headers:Record<string,string>={}){return Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers}});}
export function errorResponse(error:unknown){if(error instanceof ZodError)return json({error:'Vérifie les champs saisis.',code:'invalid_input'},400);const e=publicError(error);return json({error:e.message,code:e.code},e.status);}
export async function readRawBody(request:Request,max=16000) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('Le format JSON est requis.',415,'unsupported_media');
  if(Number(request.headers.get('content-length')||0)>max)throw new AppError('Envoi trop volumineux.',413,'body_too_large');
  const reader=request.body?.getReader();if(!reader)throw new AppError('Envoi vide.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>max){await reader.cancel();throw new AppError('Envoi trop volumineux.',413,'body_too_large');}chunks.push(r.value);}
  return Buffer.concat(chunks).toString('utf8');
}

export async function readBody(request:Request,max=16000) { const raw=await readRawBody(request,max);try{return JSON.parse(raw);}catch{throw new AppError('Le JSON est invalide.');} }
