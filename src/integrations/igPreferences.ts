import fs from 'node:fs';
import path from 'node:path';
import type {IgEnvironment} from './igConnection.js';
export function createIgPreferences(directory=path.resolve('data/ig-preferences')){
 function file(mode:IgEnvironment){if(mode!=='demo'&&mode!=='live')throw Error('Ogiltig IG-miljö');return path.join(directory,`${mode}.json`);}
 function get(mode:IgEnvironment):{favorites:string[];revision:number}{try{const value=JSON.parse(fs.readFileSync(file(mode),'utf8'));if(!Array.isArray(value.favorites)||!Number.isInteger(value.revision))throw Error('shape');return value;}catch{return {favorites:[],revision:0};}}
 function set(mode:IgEnvironment,body:any){if(!Array.isArray(body.favorites)||body.favorites.length>500||body.favorites.some((e:unknown)=>typeof e!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(e)))throw Error('Ogiltiga favoriter');const current=get(mode);if(body.revision!==current.revision)throw Error('IG-favoriter ändrades i en annan vy; hämta om');const next={favorites:[...new Set(body.favorites)] as string[],revision:current.revision+1};fs.mkdirSync(directory,{recursive:true});const dest=file(mode),temp=`${dest}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(next));fs.renameSync(temp,dest);return next;}
 return {get,set};
}
export const igPreferences=createIgPreferences();
