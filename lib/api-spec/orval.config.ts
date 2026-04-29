import { defineConfig, InputTransformerFn } from "orval";
import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// The single source of truth for the distro-list email-shape regex lives in
// `lib/distro-email/src/index.ts`. Rather than hand-copying the same source
// string into every `distro*Emails` items block in `openapi.yaml`, the YAML
// declares each pattern as the literal token `{{DISTRO_EMAIL_PATTERN}}` and
// this transformer substitutes the canonical regex source in before orval
// generates the React Query / Zod clients. Keep `lib/distro-email` as the only
// place the regex is written.
const DISTRO_PATTERN_TOKEN = "{{DISTRO_EMAIL_PATTERN}}";
const DISTRO_LIB_PATH = path.resolve(
  root,
  "lib",
  "distro-email",
  "src",
  "index.ts",
);

function readDistroPatternSource(): string {
  const src = fs.readFileSync(DISTRO_LIB_PATH, "utf8");
  const match = src.match(
    /DISTRO_EMAIL_PATTERN\s*=\s*\/(.+?)\/[gimsuy]*\s*;/,
  );
  if (!match) {
    throw new Error(
      `[orval] Could not find 'DISTRO_EMAIL_PATTERN = /.../;' in ${path.relative(root, DISTRO_LIB_PATH)}.`,
    );
  }
  return match[1];
}

function substituteDistroPatternTokens(node: unknown, source: string): void {
  if (Array.isArray(node)) {
    for (const item of node) substituteDistroPatternTokens(item, source);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === "pattern" && value === DISTRO_PATTERN_TOKEN) {
        obj[key] = source;
      } else {
        substituteDistroPatternTokens(value, source);
      }
    }
  }
}

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  substituteDistroPatternTokens(config, readDistroPatternSource());

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated/api.ts",
      mode: "single",
      clean: false,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
