import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { BrokerAdapter } from "../brokers/adapter.js";
import type { RiskManager } from "../risk/riskManager.js";
import type { AgentState } from "../memory/store.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, runTool, type ToolContext } from "./tools.js";
import { summarizePastPerformance } from "../memory/store.js";
import { log } from "../logger.js";
import type { OrderRequest, OrderResult } from "../types.js";
import type { StrategyEngine } from "../strategies/types.js";

export interface AgentTurnResult {
  finalText: string;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  placedOrders: Array<{ request: OrderRequest; result: OrderResult }>;
  killSwitchToggled: boolean;
  stopReason: string;
}

export async function runAgentTurn(params: {
  config: Config;
  broker: BrokerAdapter;
  brokers: Record<string, BrokerAdapter>;
  risk: RiskManager;
  state: AgentState;
  engines: StrategyEngine[];
  userInstruction?: string;
}): Promise<AgentTurnResult> {
  const { config, broker, brokers, risk, state, engines, userInstruction } = params;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const performance = await summarizePastPerformance();
  const systemPrompt = buildSystemPrompt(config, state, performance);

  const toolCtx: ToolContext = {
    broker,
    brokers,
    risk,
    config,
    state,
    engines,
    sideEffects: {
      placedOrders: [],
      killSwitchToggled: false,
    },
  };

  const recordedToolCalls: Array<{ name: string; input: unknown; output: unknown }> = [];

  const userMessage =
    userInstruction ??
    "Analysera marknaden just nu. Gå igenom de tillåtna symbolerna, titta på indikatorerna och dina öppna positioner, och fatta ett beslut. Lägg en order om du ser en tydlig setup — annars rapportera hold och förklara kort varför.";

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // Safety cap — vi tillåter max 15 tool-use-iterationer per turn. Detta
  // skyddar mot en runaway-loop där Claude aldrig tar ett slutgiltigt beslut.
  const MAX_ITERATIONS = 15;
  let stopReason = "unknown";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolDefinitions(),
      messages,
    });

    stopReason = response.stop_reason ?? "unknown";

    // Spara assistentens svar i messages för nästa iteration
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // Klar — Claude är färdig med sitt resonemang och har inte fler tool calls.
      const finalText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        finalText,
        toolCalls: recordedToolCalls,
        placedOrders: toolCtx.sideEffects.placedOrders,
        killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
        stopReason,
      };
    }

    // Det finns tool_use-block. Kör dem alla och bygg tool_result-block tillbaka.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      log.agent(`→ tool: ${tu.name}`, tu.input);
      const output = await runTool(
        tu.name,
        tu.input as Record<string, unknown>,
        toolCtx,
      );
      recordedToolCalls.push({ name: tu.name, input: tu.input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(output),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  log.warn(`Agent-turn nådde MAX_ITERATIONS (${MAX_ITERATIONS}) utan att avsluta.`);
  return {
    finalText: "(Agenten avslutades innan den var färdig — max iterationer nådda.)",
    toolCalls: recordedToolCalls,
    placedOrders: toolCtx.sideEffects.placedOrders,
    killSwitchToggled: toolCtx.sideEffects.killSwitchToggled,
    stopReason: "max_iterations",
  };
}
