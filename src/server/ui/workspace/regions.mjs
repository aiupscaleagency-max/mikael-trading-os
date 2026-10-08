// Lokal klassificering av valutornas regioner, inte IG:s handelsplatser.
const currencies={USD:['Nordamerika'],CAD:['Nordamerika'],MXN:['Nordamerika'],EUR:['Europa'],GBP:['Europa'],CHF:['Europa'],NOK:['Europa'],SEK:['Europa'],DKK:['Europa'],PLN:['Europa'],TRY:['Europa','Asien'],JPY:['Asien'],CNH:['Asien'],HKD:['Asien'],SGD:['Asien'],AUD:['Oceanien'],NZD:['Oceanien'],ZAR:['Afrika']};
export const regionOptions=['Nordamerika','Europa','Asien','Oceanien','Afrika','Globalt','Ej klassificerat'];
export function instrumentRegions(instrument){
  if(instrument?.category==='crypto')return {regions:['Globalt'],currencies:[],basis:'Krypto · global klassificering'};
  if(instrument?.category!=='forex')return {regions:['Ej klassificerat'],currencies:[],basis:'Verifierat valutapar saknas'};
  let codes=[];
  if(/^[A-Z]{3}$/.test(instrument.baseCurrency??'')&&/^[A-Z]{3}$/.test(instrument.quoteCurrency??''))codes=[instrument.baseCurrency,instrument.quoteCurrency];
  else{const pair=String(instrument.name??'').toUpperCase().match(/^\s*([A-Z]{3})\s*\/\s*([A-Z]{3})(?:\s*\([^)]*\))?\s*$/);if(pair)codes=pair.slice(1);}
  if(!codes.length)return {regions:['Ej klassificerat'],currencies:[],basis:'Entydiga valutakoder saknas i parnamn/metadata'};
  const regions=[...new Set(codes.flatMap(code=>currencies[code]??['Ej klassificerat']))];
  return {regions,currencies:codes,basis:codes.map(code=>`${code}: ${(currencies[code]??['Ej klassificerat']).join('/')}`).join(' · ')};
}
