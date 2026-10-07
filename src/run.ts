import 'dotenv/config';
import {startServer} from './server/api.js';
const unsupported=process.argv.slice(2).filter(x=>x!=='--serve');
if(unsupported.length)throw Error('Starta IG-handelsytan med npm run agent. Analyser startas via IG-agentsessionerna.');
const port=Number(process.env.DASHBOARD_PORT??3939);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Ogiltig dashboard-port');
const server=startServer(port);
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close();setTimeout(()=>process.exit(0),3000).unref();});
