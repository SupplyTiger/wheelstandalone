import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/rules.ts reads config/wheel-rules.yaml at runtime with fs; make sure the file ships
  // with every serverless function that might import the gate stack.
  outputFileTracingIncludes: {
    "/**": ["./config/wheel-rules.yaml"],
  },
};

export default nextConfig;
