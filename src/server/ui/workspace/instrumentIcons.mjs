// Endast lokala, fasta ikonfiler. Instrumentnamn kan aldrig bli HTML eller filvägar.
const coins={bitcoin:'btc',ethereum:'eth',solana:'sol',litecoin:'ltc',ripple:'xrp',cardano:'ada',dogecoin:'doge',polkadot:'dot',chainlink:'link',uniswap:'uni',avalanche:'avax',stellar:'xlm',cosmos:'atom',tron:'trx',eos:'eos',neo:'neo',tezos:'xtz',aave:'aave',algorand:'algo'};
const tickers=new Set(['btc','eth','sol','ltc','xrp','ada','doge','dot','link','uni','avax','bch','xlm','atom','trx','eos','etc','neo','xtz','aave','algo']);
const flags={USD:'🇺🇸',EUR:'🇪🇺',GBP:'🇬🇧',JPY:'🇯🇵',CHF:'🇨🇭',CAD:'🇨🇦',AUD:'🇦🇺',NZD:'🇳🇿',SEK:'🇸🇪',NOK:'🇳🇴',DKK:'🇩🇰',ZAR:'🇿🇦',TRY:'🇹🇷',MXN:'🇲🇽',PLN:'🇵🇱',HUF:'🇭🇺',CZK:'🇨🇿',SGD:'🇸🇬',HKD:'🇭🇰',CNH:'🇨🇳',CNY:'🇨🇳',ILS:'🇮🇱',BRL:'🇧🇷',INR:'🇮🇳'};
export function instrumentIcon(m={}){
 const name=String(m.name??m.instrumentName??'').toLowerCase();
 if(m.category==='forex'||m.category!=='crypto'&&/^[a-z]{3}\s*\/\s*[a-z]{3}\b/.test(name)){
  const pair=name.toUpperCase().match(/\b([A-Z]{3})\s*\/\s*([A-Z]{3})\b/);
  return pair?`<span class="instrument-icon forex-icon" aria-hidden="true"><span>${flags[pair[1]]??'¤'}</span><span>${flags[pair[2]]??'¤'}</span></span>`:'<span class="instrument-icon generic-icon" aria-hidden="true">¤</span>';
 }
 let symbol=name.includes('bitcoin cash')?'bch':name.includes('ethereum classic')?'etc':null;
 if(!symbol){const words=name.split(/[^a-z0-9]+/);symbol=words.map(w=>coins[w]??(tickers.has(w)?w:null)).find(Boolean)??'generic';}
 return `<img class="instrument-icon" src="/workspace/icons/${symbol}.svg" alt="" width="28" height="28">`;
}
