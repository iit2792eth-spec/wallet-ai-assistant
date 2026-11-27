import { END, START, StateGraph } from "@langchain/langgraph";
import type { AiDeps } from "./deps";
import { codeVerifierNode, routeAfterVerifier } from "./nodes/code-verifier";
import { coderNode } from "./nodes/coder";
import { executorNode, routeAfterExecutor } from "./nodes/executor";
import { planningNode, routeAfterPlanning } from "./nodes/planning";
import { GraphState, type State } from "./state";

/**
 * Query -> Planning -> (Executor) -> Coder <-> Code Verifier.
 *
 * Planning's "ask the user" loop spans requests: the graph ends with a
 * clarification result, and the user's answer starts a new run that carries
 * the conversation and the round counter (see index.ts).
 */
export function buildGraph(deps: AiDeps) {
  return new StateGraph(GraphState)
    .addNode("query", (state: State) => ({ conversation: state.conversation })) // passes the encoded query on, no interpretation
    .addNode("planning", planningNode(deps))
    .addNode("executor", executorNode(deps))
    .addNode("coder", coderNode(deps))
    .addNode("code_verifier", codeVerifierNode(deps))
    .addEdge(START, "query")
    .addEdge("query", "planning")
    .addConditionalEdges("planning", routeAfterPlanning, ["executor", "coder", END])
    .addConditionalEdges("executor", routeAfterExecutor, ["coder", END])
    .addEdge("coder", "code_verifier")
    .addConditionalEdges("code_verifier", routeAfterVerifier, ["coder", END])
    .compile();
}
