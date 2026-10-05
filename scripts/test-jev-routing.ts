import assert from "node:assert/strict";
process.env.AI_GATEWAY_API_KEY="fixture-vercel";
process.env.OPENROUTER_API_KEY="fixture-openrouter";
delete process.env.TYPESAFE_API_KEY;
const {askJev,getJevStatus,validateJevAnswers}=await import("../src/server/jevClient.js");
const questions={review:{type:"noul",instructions:"Connectivity fixture"}};
assert.equal(validateJevAnswers(questions,{}),false);
assert.equal(validateJevAnswers(questions,{review:{type:"noul",noul:2}}),false);
assert.equal(validateJevAnswers(questions,{review:{type:"noul",noul:.9}}),true);
const routes:string[]=[];
const bodies: unknown[]=[];
// Simulerat primärfel på alla direktrutter; inga anrop lämnar testprocessen.
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);routes.push(url); bodies.push(JSON.parse(String(init?.body)));
  return url.includes("openrouter")
    ? new Response(JSON.stringify({answers:{review:{type:"noul",noul:.9}},model:"fixture"}),{status:200,headers:{"content-type":"application/json","x-request-id":"fixture-jev"}})
    : new Response('{}',{status:401});
}) as typeof fetch;
const result=await askJev({symbol:"PRIVATEUSDC",close:123456,credential:"never-send",prompt:"private-prompt"},100,questions);
assert.ok(!JSON.stringify(bodies).includes("PRIVATEUSDC"));
assert.ok(!JSON.stringify(bodies).includes("never-send"));
assert.ok(!JSON.stringify(bodies).includes("private-prompt"));
assert.ok(!JSON.stringify(bodies).includes("123456"));
assert.ok(routes[0]?.includes("vercel"));
assert.ok(routes.at(-1)?.includes("openrouter"));
assert.equal(result.available,true);assert.equal(result.mode,"openrouter");
assert.equal(result.httpStatus,200);assert.equal(result.requestId,"fixture-jev");
assert.equal(getJevStatus().route,"openrouter");
assert.ok(!JSON.stringify(getJevStatus()).includes("fixture-vercel"));
console.log("PASS: JEV Vercel först, befintlig direktrutt, OpenRouter reserv och validerat svarsschema");
