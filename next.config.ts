import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // QuickJS loads its WebAssembly file at run time; bundling would break that.
  // LangChain's initChatModel imports the provider package by name at run time, so these load from node_modules
  // (with @langchain/core kept external too, so there is a single copy of it).
  // @huggingface/transformers and onnxruntime-node (injection classifier) are on Next's built-in external list.
  serverExternalPackages: [
    "quickjs-emscripten",
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-sync",
    "langchain",
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
    "@langchain/anthropic",
    "@langchain/ollama",
    "@langchain/google-genai",
  ],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
