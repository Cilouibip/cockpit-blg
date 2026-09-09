import type { LinksResponse } from './ui-contract';

export type LinkWriteResult={saved:true;links:LinksResponse|null;notice?:string};
export type LinkWriteCallbacks={save:()=>Promise<unknown>;read:()=>Promise<LinksResponse>};

/** A successful write is never recast as a failed write merely because the
 * following registry read is unavailable. Callers must not retry save when
 * `saved` is true; they can refresh the register later. */
export async function writeLinkThenRead({save,read}:LinkWriteCallbacks):Promise<LinkWriteResult>{
 await save();
 try{return {saved:true,links:await read()};}
 catch{return {saved:true,links:null,notice:'Lien enregistré. Le registre ne peut pas être relu pour le moment ; actualise-le avant de créer ou modifier un autre lien.'};}
}
