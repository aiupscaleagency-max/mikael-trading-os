# Parallell Claude-handelsyta i Agentic OS

- Befintlig vy: https://agentic-os.tail64d627.ts.net/trading
- Ny separat kategori: https://agentic-os.tail64d627.ts.net/trading-claude
- Separat fönster: https://aiupscale-dator2.tail64d627.ts.net:9444

Claude-ytan använder den arkiverade originaldesignen, portad till den befintliga IG-backendens API:er. Den gamla Bybit-/Alpaca-/Binance-motorn startas aldrig. Befintlig IG-tjänst, nycklar, orderflaggor och modellval lämnas orörda. Vyerna delar IG-kontodata, bibliotek och agentstatus.

Runtime på dator2: `~/.local/share/claude-ig-trading`, LaunchAgent `com.aiupscale.claude-ig-trading`, localhost3938. Tailscale Serve använder separat HTTPS-port9444. Agentic OS har en additiv iframe-kategori och länkar för båda fönstren.

Kontroller: TypeScript, isolerad HTTP/WebSocket-gatewayfixture, browserfixture med policyvärden och kontobyte under väntande analys. Browserfixturen gör inga verkliga AI- eller mäklaranrop. Den verkliga anslutningen kontrolleras läsande efter aktivering.

Ingen fullständig funktionsparitet utlovas: portmanifestet i Inställningar visar vad IG stöder och vad som återstår. Flerdiagram är historiksnapshots, huvuddiagrammet använder realtidsströmmen. Katalogen kommer från gemensam backend; originaldesignen ger inte automatiskt fler IG-instrument. Demo och Live visas enligt respektive verifierad anslutningsstatus.

För återställning kan den nya LaunchAgenten avlastas och Tailscale-port9444 tas bort; gamla IG-proxyn på3939 och /trading behöver inte ändras. Agentic OS-builden säkerhetskopieras före bytet till `.next-before-claude-*`.
