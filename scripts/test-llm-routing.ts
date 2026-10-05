import assert from "node:assert/strict";
process.env.AI_GATEWAY_API_KEY = "test-vercel";
process.env.OPENROUTER_API_KEY = "test-reserv";
process.env.LLM_MODEL_FALLBACK = "off";
delete process.env.ANTHROPIC_API_KEY;
const {createLlmClient,getLlmDiagnostics,fallbackModels} = await import("../src/llm/gateway.js");
const calls: Array<{url:string;model:string}> = [];
// Alla externa anrop ersätts; ingen verklig AI-kostnad eller nyckel används.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = JSON.parse(String(init?.body ?? "{}"));
  calls.push({url,model:body.model});
  if (url.includes("vercel")) throw new TypeError("fetch failed");
  return new Response(JSON.stringify({id:"msg_mock",type:"message",role:"assistant",model:body.model,
    content:[{type:"text",text:'{"ok":true}'}],stop_reason:"end_turn",stop_sequence:null,
    usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{"content-type":"application/json","request-id":"mock-request"}});
}) as typeof fetch;
const model="anthropic/claude-haiku-4.5";
await createLlmClient().messages.create({model,max_tokens:10,messages:[{role:"user",content:"test"}]},{maxRetries:0});
assert.equal(calls.length,2);
assert.ok(calls[0]?.url.includes("vercel"));
assert.ok(calls[1]?.url.includes("openrouter"));
assert.ok(calls.every((c)=>c.model===model),"Reservväg får inte byta modell");
assert.deepEqual(fallbackModels(model),[]);
const attempts=getLlmDiagnostics().attempts;
assert.equal(attempts[0]?.status,null);
assert.equal(attempts[1]?.status,200);
assert.equal(attempts[1]?.requestId,"mock-request");
assert.equal(attempts[1]?.actualModel,model);
assert.ok(!JSON.stringify(getLlmDiagnostics()).includes("test-vercel"));
console.log("PASS: nätverksfel till reservrutt, oförändrad modell, verifierad HTTP-status och hemlighetsfri diagnostik");
